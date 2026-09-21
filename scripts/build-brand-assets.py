"""Trace the approved monochrome reference into transparent SVG assets."""
from pathlib import Path
import sys
import cv2
import numpy as np
from PIL import Image

source = Image.open(sys.argv[1]).convert('RGB')
root = Path(__file__).resolve().parent.parent
assets = root / 'public' / 'assets'

def trace(box, destination):
    pixels = np.asarray(source.crop(box))
    mask = (pixels.mean(axis=2) < 110).astype('uint8') * 255
    contours, _ = cv2.findContours(mask, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)
    paths = []
    for contour in contours:
        if abs(cv2.contourArea(contour)) < 4:
            continue
        points = cv2.approxPolyDP(contour, 0.3, True).reshape(-1, 2)
        paths.append('M' + 'L'.join(f'{x},{y}' for x, y in points) + 'Z')
    width, height = box[2] - box[0], box[3] - box[1]
    destination.write_text(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}"><path fill="#191919" fill-rule="evenodd" d="{"".join(paths)}"/></svg>\n', encoding='utf8')

trace((135, 193, 1146, 399), assets / 'benchpoll-logo.svg')
trace((135, 193, 344, 399), assets / 'benchpoll-mark.svg')
