"""Generate the site's static Manrope weights from its licensed variable source."""

import hashlib
import json
from pathlib import Path

from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

root = Path(__file__).resolve().parent.parent
directory = root / "public" / "assets" / "fonts"
source = directory / "manrope.ttf"
weights = (400, 500, 600, 700, 800)
generated = []

with TTFont(source, recalcTimestamp=False) as font:
    assert [(axis.axisTag, axis.minValue, axis.maxValue) for axis in font["fvar"].axes] == [
        ("wght", 200, 800)
    ]
    for weight in weights:
        instance = instantiateVariableFont(font, {"wght": weight}, updateFontNames=True)
        assert "fvar" not in instance and "gvar" not in instance
        assert instance["OS/2"].usWeightClass == weight
        instance.flavor = "woff2"
        target = directory / f"manrope-{weight}.woff2"
        instance.save(target)
        generated.append({
            "path": str(target.relative_to(root)).replace("\\", "/"),
            "weight": weight,
            "bytes": target.stat().st_size,
            "sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
        })
        instance.close()

print(json.dumps({
    "source": "public/assets/fonts/manrope.ttf",
    "sourceSHA256": hashlib.sha256(source.read_bytes()).hexdigest(),
    "license": "public/assets/fonts/manrope-OFL.txt",
    "files": generated,
}, indent=2))
