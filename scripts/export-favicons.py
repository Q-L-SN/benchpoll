"""Export favicon sizes from the SVG rendered by frontend/brand-refresh.mjs."""
from pathlib import Path
from PIL import Image

public = Path(__file__).resolve().parent.parent / 'public'
image = Image.open(public / 'assets/favicon-512.png').convert('RGBA')
image.save(public / 'favicon.ico', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
for size, name in [(64, 'favicon-64.png'), (180, 'apple-touch-icon.png')]:
    image.resize((size, size), Image.Resampling.LANCZOS).save(public / 'assets' / name)
