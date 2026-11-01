"""Build optional, outline-identical icon font subsets without changing originals."""

import argparse
import hashlib
import json
import re
from pathlib import Path

import tinycss2
from fontTools import subset
from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.ttLib import TTFont


def sha(data):
    return hashlib.sha256(data).hexdigest()


def outline(font, code):
    glyphs = font.getGlyphSet()
    pen = DecomposingRecordingPen(glyphs)
    glyph = glyphs[font.getBestCmap()[code]]
    glyph.draw(pen)
    return glyph.width, pen.value


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--source-root", required=True)
parser.add_argument("--output", required=True)
args = parser.parse_args()
root, output = Path(args.source_root).resolve(), Path(args.output).resolve()
assert output != root
output.mkdir(parents=True, exist_ok=False)

vendor = root / "public/vendor/fontawesome"
css_bytes = (vendor / "css/all.min.css").read_bytes()
codes_by_name = {}
for rule in tinycss2.parse_stylesheet(css_bytes.decode("utf-8"), skip_comments=True, skip_whitespace=True):
    if rule.type != "qualified-rule":
        continue
    declarations = tinycss2.parse_declaration_list(rule.content, skip_comments=True, skip_whitespace=True)
    for declaration in declarations:
        if declaration.type != "declaration" or declaration.lower_name != "content":
            continue
        tokens = [token for token in declaration.value if token.type != "whitespace"]
        if len(tokens) != 1 or tokens[0].type != "string" or len(tokens[0].value) != 1:
            continue
        names = [token.value for token in rule.prelude if token.type == "ident" and token.value.startswith("fa-")]
        for name in names:
            code = ord(tokens[0].value)
            assert name not in codes_by_name or codes_by_name[name] == code
            codes_by_name[name] = code
assert len(codes_by_name) > 1000

source_hashes, names, explicit_codes = [], set(), set()
for directory in ["private", "public/js", "public/css"]:
    for path in sorted((root / directory).rglob("*")):
        if not path.is_file() or path.suffix not in {".html", ".js", ".css"}:
            continue
        data = path.read_bytes()
        source_hashes.append({"path": path.relative_to(root).as_posix(), "hash": sha(data)})
        text = data.decode("utf-8")
        names.update(re.findall(r"\bfa-[a-z0-9][a-z0-9-]*\b", text))
        explicit_codes.update(int(value, 16) for value in re.findall(r"\\u([0-9a-fA-F]{4})", text))
codes = {codes_by_name[name] for name in names if name in codes_by_name} | explicit_codes
families = [
    ("solid", "fa-solid-900.woff2", "BenchPoll UI Icons", 900),
    ("regular", "fa-regular-400.woff2", "BenchPoll UI Icons", 400),
    ("brands", "fa-brands-400.woff2", "BenchPoll UI Brands", 400),
]
styles, files, verification = [], [], []
for kind, source_name, family, weight in families:
    source_path = vendor / "webfonts" / source_name
    source_bytes = source_path.read_bytes()
    source_hashes.append({"path": source_path.relative_to(root).as_posix(), "hash": sha(source_bytes)})
    with TTFont(source_path, recalcTimestamp=False) as original:
        wanted = sorted(codes & original.getBestCmap().keys())
        assert wanted
        expected = {code: outline(original, code) for code in wanted}
        with TTFont(source_path, recalcTimestamp=False) as font:
            options = subset.Options()
            options.ignore_missing_unicodes = False
            options.name_IDs = ["*"]
            options.name_languages = ["*"]
            subsetter = subset.Subsetter(options=options)
            subsetter.populate(unicodes=wanted)
            subsetter.subset(font)
            postscript = "BenchPollUIIcons-" + kind.title()
            for record in font["name"].names:
                value = {1: family, 3: postscript + "-Subset-1", 4: family + " " + kind.title(),
                         6: postscript, 16: family, 18: family, 21: family}.get(record.nameID)
                if value is not None:
                    record.string = value.encode(record.getEncoding())
            if "CFF " in font:
                cff = font["CFF "].cff
                cff.fontNames = [postscript]
                for top in cff.topDictIndex:
                    top.FamilyName = family
                    top.FullName = family + " " + kind.title()
            font.flavor = "woff2"
            temporary = output / (kind + ".woff2")
            font.save(temporary)
        data = temporary.read_bytes()
        asset_path = "public/assets/fonts/benchpoll-icons-" + kind + "-" + sha(data)[:16] + ".woff2"
        destination = output / asset_path
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary.rename(destination)
        with TTFont(destination, recalcTimestamp=False) as generated:
            assert generated["OS/2"].usWeightClass == weight
            assert set(generated.getBestCmap()) == set(wanted)
            for code in wanted:
                assert outline(generated, code) == expected[code], f"Changed outline or width: {kind} U+{code:04X}"
            assert all("Font Awesome" not in record.toUnicode() for record in generated["name"].names
                       if record.nameID in {1, 3, 4, 6, 16, 18, 21})
        ranges = ", ".join(f"U+{code:04X}" for code in wanted)
        styles.append(f"@font-face {{\n    font-family: '{family}';\n    font-style: normal;\n"
                      f"    font-weight: {weight};\n    font-display: block;\n"
                      f"    src: url('/{asset_path[7:]}') format('woff2');\n    unicode-range: {ranges};\n}}\n")
        files.append({"path": asset_path, "hash": sha(data), "bytes": len(data)})
        verification.append({"kind": kind, "family": family, "weight": weight, "codes": wanted,
                             "originalBytes": len(source_bytes), "subsetBytes": len(data),
                             "outlineAndWidthChecks": len(wanted), "reservedFontNamesRemoved": True})

styles.append(".bp-home .fa, .bp-home .fa-solid, .bp-home .fa-regular, .bp-home .fas, .bp-home .far,\n"
              ".bp-home .bp-pie-fallback-icon {\n    font-family: 'BenchPoll UI Icons', 'Font Awesome 6 Free';\n}\n\n"
              ".bp-home .fa-brands, .bp-home .fab {\n    font-family: 'BenchPoll UI Brands', 'Font Awesome 6 Brands';\n}\n")
css = ("/* Generated by scripts/build-home-icon-fonts.py. Original fonts remain the fallback.\n"
       "   Fonticons, Inc. Copyright 2023; derivatives licensed under SIL OFL 1.1.\n"
       "   License: /assets/fonts/benchpoll-icons-OFL.txt */\n\n" + "\n".join(styles)).encode("utf-8")
license_bytes = (vendor / "LICENSE.txt").read_bytes()
for path, data in [("public/css/ui/home-icon-fonts.css", css), ("public/assets/fonts/benchpoll-icons-OFL.txt", license_bytes)]:
    destination = output / path
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(data)
    files.append({"path": path, "hash": sha(data), "bytes": len(data)})
source_hashes.extend([{"path": "public/vendor/fontawesome/css/all.min.css", "hash": sha(css_bytes)},
                      {"path": "public/vendor/fontawesome/LICENSE.txt", "hash": sha(license_bytes)}])
for source in source_hashes:
    assert sha((root / source["path"]).read_bytes()) == source["hash"], "Concurrent source change: " + source["path"]
report = {"sourceRoot": str(root), "output": str(output), "sourceHashes": source_hashes,
          "files": files, "fonts": verification, "usedIconNames": sorted(names & codes_by_name.keys()),
          "originalsChanged": False, "fullFontsRemainFallback": True}
(output / "manifest.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"output": str(output), "files": len(files), "fonts": verification}))
