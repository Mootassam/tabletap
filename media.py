"""Image uploads and QR codes.

Uploads are decoded with Pillow and RE-ENCODED to WebP: whatever bytes the browser sent
(a polyglot file, EXIF GPS data, a 40 MB phone photo) never reach disk as-is.
"""
import io
import os
import secrets

import segno
from PIL import Image, ImageOps

import app_paths

Image.MAX_IMAGE_PIXELS = 60_000_000  # decompression-bomb guard (~60 MP)

KINDS = {
    # kind: (max width, max height, crop to aspect or None)
    "item": (1200, 1200, None),
    "logo": (512, 512, None),
    "cover": (1920, 900, None),
}


class MediaError(Exception):
    pass


def save_image(file_storage, kind="item"):
    """Validate + resize + re-encode. Returns the public filename (e.g. 'a1b2c3.webp')."""
    if kind not in KINDS:
        raise MediaError("Unknown image kind")
    data = file_storage.read()
    if not data:
        raise MediaError("The file is empty")
    try:
        probe = Image.open(io.BytesIO(data))
        probe.verify()                      # structural check
        img = Image.open(io.BytesIO(data))  # verify() leaves the image unusable; reopen
        img.load()
    except Image.DecompressionBombError:
        raise MediaError("That image is too large")
    except Exception:
        raise MediaError("That file is not a supported image (use JPG, PNG or WebP)")
    if img.format not in ("JPEG", "PNG", "WEBP", "GIF", "BMP", "MPO"):
        raise MediaError("Unsupported image format: %s" % img.format)

    img = ImageOps.exif_transpose(img)      # respect phone rotation, then EXIF is dropped
    has_alpha = img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info)
    img = img.convert("RGBA" if has_alpha else "RGB")
    max_w, max_h, _ = KINDS[kind]
    img.thumbnail((max_w, max_h), Image.LANCZOS)

    name = "%s-%s.webp" % (kind, secrets.token_hex(8))
    path = os.path.join(app_paths.UPLOAD_DIR, name)
    img.save(path, "WEBP", quality=84, method=5)
    return name


def delete_image(name):
    if not name or "/" in name or "\\" in name or ".." in name:
        return
    path = os.path.join(app_paths.UPLOAD_DIR, name)
    try:
        os.remove(path)
    except OSError:
        pass


def qr_svg(url, dark="#111111", light=None, scale=10, border=2):
    qr = segno.make(url, error="q", micro=False)
    buf = io.BytesIO()
    qr.save(buf, kind="svg", scale=scale, border=border, dark=dark, light=light, xmldecl=False,
            svgns=True, svgclass="qr", lineclass=None, omitsize=True)
    return buf.getvalue().decode("utf-8")


def qr_png(url, dark="#111111", scale=16, border=2):
    qr = segno.make(url, error="q", micro=False)
    buf = io.BytesIO()
    qr.save(buf, kind="png", scale=scale, border=border, dark=dark, light="#ffffff")
    return buf.getvalue()
