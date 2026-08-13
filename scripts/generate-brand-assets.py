from __future__ import annotations

from io import BytesIO
from pathlib import Path

import cairosvg
from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
SVG = ROOT / "resources" / "icons" / "agentplay-mark.svg"
RESAMPLE = Image.Resampling.LANCZOS


def render_svg(size: int = 1024) -> Image.Image:
    data = cairosvg.svg2png(url=str(SVG), output_width=size, output_height=size)
    return Image.open(BytesIO(data)).convert("RGBA")


def save_png(image: Image.Image, path: Path, size: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    image.resize((size, size), RESAMPLE).save(path, "PNG", optimize=True)


master = render_svg()
save_png(master, ROOT / "resources" / "icons" / "app-icon.png", 1024)
save_png(master, ROOT / "public" / "icons" / "icon-512.png", 512)
save_png(master, ROOT / "public" / "icons" / "icon-192.png", 192)
save_png(master, ROOT / "public" / "icons" / "favicon-64.png", 64)

ico_path = ROOT / "resources" / "icons" / "app-icon.ico"
master.save(ico_path, "ICO", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

for size in (16, 48, 128):
    save_png(master, ROOT / "extension" / "icons" / f"{size}.png", size)

android_assets = ROOT / "android" / "app" / "src" / "main" / "assets" / "public" / "icons"
for filename, size in (("favicon-64.png", 64), ("icon-192.png", 192), ("icon-512.png", 512)):
    save_png(master, android_assets / filename, size)

density_sizes = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
for density, size in density_sizes.items():
    folder = ROOT / "android" / "app" / "src" / "main" / "res" / f"mipmap-{density}"
    save_png(master, folder / "ic_launcher.png", size)
    save_png(master, folder / "ic_launcher_round.png", size)
    # Adaptive foreground has a larger canvas; keeping the complete mark in the
    # inner safe zone prevents Android launchers from clipping the dove.
    foreground_size = round(size * 2.25)
    canvas = Image.new("RGBA", (foreground_size, foreground_size), (0, 0, 0, 0))
    mark = master.resize((round(foreground_size * 0.66), round(foreground_size * 0.66)), RESAMPLE)
    offset = ((foreground_size - mark.width) // 2, (foreground_size - mark.height) // 2)
    canvas.alpha_composite(mark, offset)
    canvas.save(folder / "ic_launcher_foreground.png", "PNG", optimize=True)

for splash in (ROOT / "android" / "app" / "src" / "main" / "res").glob("drawable*/splash.png"):
    with Image.open(splash) as current:
        width, height = current.size
    canvas = Image.new("RGBA", (width, height), (255, 255, 255, 255))
    mark_size = max(72, round(min(width, height) * 0.16))
    mark = master.resize((mark_size, mark_size), RESAMPLE)
    canvas.alpha_composite(mark, ((width - mark_size) // 2, (height - mark_size) // 2))
    canvas.convert("RGB").save(splash, "PNG", optimize=True)

print("AgentPlay brand assets generated: Windows, Web/PWA, extension, Android and splash")
