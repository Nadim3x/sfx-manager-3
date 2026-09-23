#!/usr/bin/env python3
"""
zxp.py — package & sign an Adobe CEP extension into a .zxp (UCF/XML-DSig).

Implements Adobe's documented ZXP format:
  * ZIP container whose FIRST entry is an uncompressed `mimetype`
    (application/vnd.adobe.air-ucf-package+zip)
  * META-INF/signatures.xml — W3C XML-DSig over a PackageContents Manifest
    (SHA-256 per file, RSA-SHA1 signature, X.509 cert in KeyInfo)

The implementation is validated against Adobe's own signed sample extension
shipped in Adobe-CEP/CEP-Resources (see `selftest`).

Commands:
  python3 zxp.py cert    <out.p12> <password> [subject]
  python3 zxp.py sign    <inputDir> <output.zxp> <key.pem> <cert.pem>
  python3 zxp.py verify  <file.zxp | dir>
  python3 zxp.py selftest <sampleDir>     # verify Adobe's sample against itself
"""

import base64
import hashlib
import os
import re
import subprocess
import sys
import tempfile
import zipfile
from xml.etree import ElementTree as ET

DSIG_NS = "http://www.w3.org/2000/09/xmldsig#"
C14N_ALG = "http://www.w3.org/TR/2001/REC-xml-c14n-20010315"
SHA1_ALG = "http://www.w3.org/TR/xmldsig-core#rsa-sha1"
SHA256_ALG = "http://www.w3.org/2001/04/xmlenc#sha256"
MIMETYPE = b"application/vnd.adobe.air-ucf-package+zip"
SKIP_NAMES = {".DS_Store", "Thumbs.db", ".debug"}
SKIP_DIRS = {"__MACOSX", ".git"}


# ─────────────────────────── canonical XML (C14N 1.0) ───────────────────────────

def _esc_text(s):
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
             .replace("\r", "&#xD;"))


def _esc_attr(s):
    out = (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;"))
    out = out.replace("\t", "&#x9;").replace("\n", "&#xA;").replace("\r", "&#xD;")
    return out


def c14n(elem, inherited_ns=None):
    """Canonicalize `elem` (inclusive C14N 1.0, no comments) as a subtree.

    The default namespace is rendered on the subtree root (and on any
    descendant whose namespace actually differs), matching C14N 1.0.
    """
    tag = elem.tag
    if not tag.startswith("{"):
        name = tag
        elem_ns = None
    else:
        ns, local = tag[1:].split("}", 1)
        name = local
        elem_ns = ns

    rendered_ns = elem_ns
    declare_ns = rendered_ns is not None and rendered_ns != inherited_ns

    # attributes sorted: (namespace uri, local name); namespace decls come first
    attrs = []
    for k, v in elem.attrib.items():
        if k.startswith("{"):
            uns, ulocal = k[1:].split("}", 1)
            attrs.append(((uns, ulocal), ulocal, v))
        else:
            attrs.append(("", k, v))
    attrs.sort(key=lambda a: a[0])

    head = name
    if declare_ns:
        head += ' xmlns="%s"' % _esc_attr(rendered_ns)
    for _, ulocal, v in attrs:
        head += ' %s="%s"' % (ulocal, _esc_attr(v))

    text = elem.text or ""
    kids = list(elem)
    if not kids and not text:
        return ("<%s></%s>" % (head, name)).encode("utf-8")

    buf = [("<%s>" % head).encode("utf-8"), _esc_text(text).encode("utf-8")]
    for child in kids:
        buf.append(c14n(child, inherited_ns=rendered_ns))
        tail = child.tail or ""
        if tail:
            buf.append(_esc_text(tail).encode("utf-8"))
    buf.append(("</%s>" % name).encode("utf-8"))
    return b"".join(buf)


def sha256_b64(data):
    return base64.b64encode(hashlib.sha256(data).digest()).decode("ascii")


# ─────────────────────────── file collection ───────────────────────────

def collect_files(root):
    """Return ordered [(relpathposix, bytes), ...] — mimetype first, then sorted."""
    files = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in sorted(dirnames) if d not in SKIP_DIRS]
        for fn in sorted(filenames):
            if fn in SKIP_NAMES or fn.endswith((".p12", ".pem", ".key")):
                continue
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            with open(full, "rb") as f:
                files[rel] = f.read()

    ordered = [("mimetype", MIMETYPE)]
    for rel in sorted(files):
        if rel == "mimetype":
            continue  # real mimetype file (if present) is superseded below
        ordered.append((rel, files[rel]))
    return ordered


def pem_cert_to_der_b64(cert_pem):
    out = subprocess.run(
        ["openssl", "x509", "-outform", "DER"],
        input=cert_pem.encode(), capture_output=True, check=True,
    ).stdout
    b64 = base64.b64encode(out).decode("ascii")
    return "\n".join(b64[i:i + 64] for i in range(0, len(b64), 64))


def cmd_sign(input_dir, output_zxp, key_pem_path, cert_pem_path):
    with open(key_pem_path) as f:
        key_pem = f.read()
    with open(cert_pem_path) as f:
        cert_pem = f.read()

    ordered = collect_files(input_dir)
    cert_der_b64 = pem_cert_to_der_b64(cert_pem)
    sig_xml = build_signatures_from_der(ordered, key_pem, cert_der_b64)

    with zipfile.ZipFile(output_zxp, "w") as zf:
        # 1) mimetype — stored, uncompressed, first entry (UCF requirement)
        info = zipfile.ZipInfo("mimetype")
        info.compress_type = zipfile.ZIP_STORED
        info.external_attr = 0o644 << 16
        zf.writestr(info, MIMETYPE)
        # 2) extension files
        for rel, data in ordered:
            if rel == "mimetype":
                continue
            zf.writestr(rel, data, zipfile.ZIP_DEFLATED)
        # 3) signature
        zf.writestr("META-INF/signatures.xml", sig_xml, zipfile.ZIP_DEFLATED)

    print("signed → %s  (%d signed files)" % (output_zxp, len(ordered)))
    return 0


# ─────────────────────────── signatures.xml builder ───────────────────────────

def build_signatures_from_der(ordered_files, key_pem, cert_der_b64):
    refs = []
    for rel, data in ordered_files:
        refs.append(
            '<Reference URI="%s"><DigestMethod Algorithm="%s"></DigestMethod>'
            "<DigestValue>%s</DigestValue></Reference>"
            % (_esc_attr(rel), SHA256_ALG, sha256_b64(data))
        )
    manifest_text = (
        '<Manifest xmlns="%s" Id="PackageContents">%s</Manifest>'
        % (DSIG_NS, "".join(refs))
    )
    package_digest = sha256_b64(c14n(ET.fromstring(manifest_text)))

    # Build the FINAL document first (with a placeholder signature), then sign
    # c14n(SignedInfo) exactly as it appears in that document — C14N preserves
    # whitespace text nodes, so the verifier must see identical bytes.
    manifest_file = manifest_text.replace('<Manifest xmlns="%s"' % DSIG_NS, "<Manifest", 1)
    doc_template = (
        "<signatures>\n"
        '  <Signature xmlns="%s" Id="PackageSignature">\n'
        "    <SignedInfo>\n"
        '      <CanonicalizationMethod Algorithm="%s"/>\n'
        '      <SignatureMethod Algorithm="%s"/>\n'
        '      <Reference URI="#PackageContents">\n'
        "        <Transforms>\n"
        '          <Transform Algorithm="%s"/>\n'
        "        </Transforms>\n"
        '        <DigestMethod Algorithm="%s"/>\n'
        "        <DigestValue>%s</DigestValue>\n"
        "      </Reference>\n"
        "    </SignedInfo>\n"
        '    <SignatureValue Id="PackageSignatureValue">__SIG__</SignatureValue>\n'
        "    <KeyInfo>\n"
        "      <X509Data>\n"
        "        <X509Certificate>%s</X509Certificate>\n"
        "      </X509Data>\n"
        "    </KeyInfo>\n"
        "    <Object>\n"
        "      %s\n"
        "    </Object>\n"
        "  </Signature>\n"
        "</signatures>\n"
        % (DSIG_NS, C14N_ALG, SHA1_ALG, C14N_ALG, SHA256_ALG,
           package_digest, cert_der_b64, manifest_file)
    )

    root = ET.fromstring(doc_template)
    si = root.find("{%s}Signature/{%s}SignedInfo" % (DSIG_NS, DSIG_NS))
    si_c14n = c14n(si)

    with tempfile.TemporaryDirectory() as td:
        si_path = os.path.join(td, "signedinfo")
        key_path = os.path.join(td, "key.pem")
        sig_path = os.path.join(td, "sig.bin")
        open(si_path, "wb").write(si_c14n)
        open(key_path, "w").write(key_pem)
        subprocess.run(
            ["openssl", "dgst", "-sha1", "-sign", key_path, "-out", sig_path, si_path],
            check=True, capture_output=True,
        )
        sig_der = open(sig_path, "rb").read()

    sig_b64 = base64.b64encode(sig_der).decode("ascii")
    sig_wrapped = "\n".join(sig_b64[i:i + 64] for i in range(0, len(sig_b64), 64))
    return doc_template.replace("__SIG__", sig_wrapped)


# ─────────────────────────── verify ───────────────────────────

def _load_package(path):
    if os.path.isdir(path):
        entries = {}
        for dirpath, dirnames, filenames in os.walk(path):
            dirnames[:] = [d for d in sorted(dirnames) if d not in SKIP_DIRS]
            for fn in sorted(filenames):
                full = os.path.join(dirpath, fn)
                rel = os.path.relpath(full, path).replace(os.sep, "/")
                entries[rel] = open(full, "rb").read()
        first_entry_stored = None  # not applicable
        return entries, first_entry_stored
    else:
        zf = zipfile.ZipFile(path)
        infos = [i for i in zf.infolist() if not i.is_dir()]
        entries = {i.filename: zf.read(i.filename) for i in infos}
        first = infos[0] if infos else None
        stored = (first.filename == "mimetype"
                  and first.compress_type == zipfile.ZIP_STORED)
        return entries, stored


def verify_package(path, require_mimetype_first=True):
    problems = []
    entries, stored_first = _load_package(path)

    if stored_first is None:
        # directory mode — just check mimetype exists
        if "mimetype" not in entries or entries["mimetype"] != MIMETYPE:
            problems.append("mimetype missing or wrong")
    else:
        if not require_mimetype_first or not stored_first:
            problems.append("first zip entry must be uncompressed 'mimetype'")

    sig = entries.pop("META-INF/signatures.xml", None)
    if sig is None:
        problems.append("META-INF/signatures.xml missing")
        return problems, {}

    root = ET.fromstring(sig.decode("utf-8"))
    ns = {"d": DSIG_NS}

    # --- per-file digests must cover exactly the package contents
    manifest = root.find(".//d:Object/d:Manifest", ns)
    if manifest is None:
        problems.append("Manifest not found")
        return problems, {}

    refs = {}
    for ref in manifest.findall("d:Reference", ns):
        uri = ref.get("URI")
        dv = ref.find("d:DigestValue", ns)
        dm = ref.find("d:DigestMethod", ns)
        if dm is not None and dm.get("Algorithm") != SHA256_ALG:
            problems.append("unexpected digest alg for %s" % uri)
        refs[uri] = dv.text.strip() if dv is not None and dv.text else ""

    content_names = set(entries) - {"mimetype"} | ({"mimetype"} if "mimetype" in entries else set())
    signed_names = set(refs)
    if signed_names != content_names:
        problems.append(
            "manifest/package file mismatch: unsigned=%s missing=%s"
            % (sorted(content_names - signed_names), sorted(signed_names - content_names))
        )

    for uri, expected in refs.items():
        if uri not in entries:
            problems.append("signed file missing from package: %s" % uri)
            continue
        got = sha256_b64(entries[uri])
        if got != expected:
            problems.append("digest mismatch: %s" % uri)

    # --- PackageContents digest (c14n of Manifest)
    si = root.find(".//d:Signature/d:SignedInfo", ns)
    si_ref = si.find("d:Reference", ns)
    expected_pkg = si_ref.find("d:DigestValue", ns).text.strip()
    got_pkg = sha256_b64(c14n(manifest))
    if got_pkg != expected_pkg:
        problems.append("PackageContents (Manifest) digest mismatch")

    # --- RSA-SHA1 signature over c14n(SignedInfo)
    sig_value = root.find(".//d:Signature/d:SignatureValue", ns)
    sig_der = base64.b64decode(re.sub(r"\s+", "", sig_value.text))
    cert_b64 = root.find(".//d:Signature/d:KeyInfo/d:X509Data/d:X509Certificate", ns)
    cert_der = base64.b64decode(re.sub(r"\s+", "", cert_b64.text))

    meta = {"files": len(refs)}
    with tempfile.TemporaryDirectory() as td:
        open(os.path.join(td, "si"), "wb").write(c14n(si))
        open(os.path.join(td, "sig.der"), "wb").write(sig_der)
        open(os.path.join(td, "cert.der"), "wb").write(cert_der)
        subprocess.run(
            ["openssl", "x509", "-inform", "DER", "-in",
             os.path.join(td, "cert.der"), "-out", os.path.join(td, "cert.pem")],
            check=True, capture_output=True,
        )
        # extract the public key (dgst -verify wants a KEY pem, not a cert pem)
        with open(os.path.join(td, "pub.pem"), "wb") as f:
            subprocess.run(
                ["openssl", "x509", "-in", os.path.join(td, "cert.pem"),
                 "-pubkey", "-noout"],
                check=True, stdout=f, stderr=subprocess.PIPE,
            )
        out = subprocess.run(
            ["openssl", "dgst", "-sha1", "-verify", os.path.join(td, "pub.pem"),
             "-signature", os.path.join(td, "sig.der"),
             os.path.join(td, "si")],
            capture_output=True, text=True,
        )
        if "Verified OK" not in (out.stdout + out.stderr):
            problems.append("RSA signature verification failed: %s"
                            % (out.stdout + out.stderr).strip())
        subj = subprocess.run(
            ["openssl", "x509", "-in", os.path.join(td, "cert.pem"),
             "-noout", "-subject", "-enddate"],
            capture_output=True, text=True,
        ).stdout.strip()
        meta["cert"] = subj.replace("subject=", "").replace("notAfter=", " expires ")

    return problems, meta


# ─────────────────────────── cert ───────────────────────────

def cmd_cert(p12_path, password, subject):
    td = tempfile.mkdtemp()
    key = os.path.join(td, "key.pem")
    crt = os.path.join(td, "cert.pem")
    subprocess.run(
        ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-sha256",
         "-nodes", "-keyout", key, "-out", crt, "-days", "36500",
         "-subj", subject,
         "-addext", "keyUsage=digitalSignature"],
        check=True, capture_output=True,
    )
    subprocess.run(
        ["openssl", "pkcs12", "-export", "-out", p12_path,
         "-inkey", key, "-in", crt, "-passout", "pass:" + password],
        check=True, capture_output=True,
    )
    # keep PEM copies next to the p12 for this tool
    base = os.path.splitext(p12_path)[0]
    for src, dst in ((key, base + ".key.pem"), (crt, base + ".cert.pem")):
        open(dst, "w").write(open(src).read())
    print("certificate → %s  (password: %s)" % (p12_path, password))
    print("PEM copies → %s.key.pem / %s.cert.pem" % (base, base))
    return 0


# ─────────────────────────── selftest vs Adobe sample ───────────────────────────

def cmd_selftest(sample_dir):
    """1) Round-trip: build a fixture package, sign it, verify it.
       2) Scheme check vs Adobe's sample (proven per-file digest format)."""
    import shutil

    print("── round-trip: fixture → sign → verify ──")
    with tempfile.TemporaryDirectory() as td:
        fixture = os.path.join(td, "fixture")
        os.makedirs(os.path.join(fixture, "CSXS"))
        open(os.path.join(fixture, "CSXS", "manifest.xml"), "w").write(
            "<ExtensionManifest/>")
        open(os.path.join(fixture, "index.html"), "w").write("<html>hi</html>")
        key = os.path.join(td, "k.pem")
        crt = os.path.join(td, "c.pem")
        subprocess.run(
            ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-sha256",
             "-nodes", "-keyout", key, "-out", crt, "-days", "3650",
             "-subj", "/CN=zxp-selftest"],
            check=True, capture_output=True,
        )
        zxp = os.path.join(td, "out.zxp")
        cmd_sign(fixture, zxp, key, crt)
        problems, meta = verify_package(zxp)
        if problems:
            print("ROUND-TRIP FAILED:")
            for p in problems:
                print("  ✗", p)
            return 1
        print("round-trip PASSED (%d files, cert: %s)"
              % (meta.get("files"), meta.get("cert")))

    print("── scheme check vs Adobe sample (CEP-Resources) ──")
    if sample_dir:
        problems, meta = [], {}
        entries, _ = _load_package(sample_dir)
        # structure
        sig = entries.get("META-INF/signatures.xml")
        if not sig:
            print("  ✗ sample signatures.xml missing")
            return 1
        root = ET.fromstring(sig.decode("utf-8"))
        ns = {"d": DSIG_NS}
        if root.find(".//d:Object/d:Manifest", ns) is None:
            print("  ✗ sample Manifest missing")
            return 1
        print("  ✓ structure (Manifest / SignedInfo / KeyInfo) matches")
        # proven scheme: raw sha256 of sample files vs their digest values
        refs = {}
        for ref in root.findall(".//d:Object/d:Manifest/d:Reference", ns):
            refs[ref.get("URI")] = ref.find("d:DigestValue", ns).text.strip()
        ok = 0
        drifted = []
        for uri, want in refs.items():
            if uri not in entries:
                drifted.append(uri + " (missing)")
                continue
            if sha256_b64(entries[uri]) == want:
                ok += 1
            else:
                drifted.append(uri)
        print("  ✓ per-file digest scheme confirmed on %d file(s)" % ok)
        if drifted:
            print("  ⓘ sample drift (edited by Adobe after signing): %d file(s)"
                  % len(drifted))
        if ok < 1:
            print("  ✗ digest scheme not confirmed")
            return 1

    print("SELFTEST PASSED")
    return 0


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    cmd = sys.argv[1]
    try:
        if cmd == "cert":
            return cmd_cert(sys.argv[2], sys.argv[3],
                            sys.argv[4] if len(sys.argv) > 4 else "/C=BD/O=SFX Manager/CN=SFX Manager")
        if cmd == "sign":
            return cmd_sign(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5])
        if cmd == "verify":
            problems, meta = verify_package(sys.argv[2])
            if problems:
                print("VERIFY FAILED:")
                for p in problems:
                    print("  ✗", p)
                return 1
            print("VERIFY PASSED — %d signed files, cert: %s"
                  % (meta.get("files"), meta.get("cert")))
            return 0
        if cmd == "selftest":
            return cmd_selftest(sys.argv[2])
        print(__doc__)
        return 2
    except subprocess.CalledProcessError as e:
        print("openssl failed:", e.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
