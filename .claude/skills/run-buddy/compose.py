"""Superpone el overlay (buddy) sobre la captura de la pantalla X: python3 compose.py /tmp/buddy-run"""
import sys
from PIL import Image

out = sys.argv[1] if len(sys.argv) > 1 else '/tmp/buddy-run'
screen = Image.open(f'{out}/screen.png').convert('RGBA')
overlay = Image.open(f'{out}/overlay.png').convert('RGBA').resize(screen.size)
screen.alpha_composite(overlay)
screen.convert('RGB').save(f'{out}/composite.png')
print(f'{out}/composite.png')
