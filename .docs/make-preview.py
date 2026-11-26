# -*- coding: utf-8 -*-
"""生成 Folia 模组市场用的 preview.png（1280x720）。

沙箱里跑不起 Electron GUI，所以这里不是真截图，而是按模组页面里的真实配色与尺寸
合成的一张示意图：底部是「桌面歌词」窗口，右上是「悬浮窗歌词」窗口。

用法：
    python make-preview.py           # 输出 ../preview.png
"""
import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

W, H = 1280, 720
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "preview.png")

YAHEI = r"C:\Windows\Fonts\msyh.ttc"
YAHEI_BOLD = r"C:\Windows\Fonts\msyhbd.ttc"


def font(path, size):
    return ImageFont.truetype(path, size)


# ---------------------------------------------------------------- 背景
bg = Image.new("RGB", (W, H), "#101520")
d = ImageDraw.Draw(bg)
for y in range(H):
    k = y / (H - 1)
    r = int(16 + 12 * k)
    g = int(21 + 16 * k)
    b = int(32 + 22 * k)
    d.line([(0, y), (W, y)], fill=(r, g, b))

# 左上角的柔光，模拟壁纸
glow = Image.new("RGB", (W, H), "#000000")
gd = ImageDraw.Draw(glow)
gd.ellipse([-260, -320, 720, 380], fill=(38, 66, 104))
glow = glow.filter(ImageFilter.GaussianBlur(120))
bg = Image.blend(bg, glow, 0.55)

canvas = bg.convert("RGBA")


def panel(box, radius, fill, outline, width=1):
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ld = ImageDraw.Draw(layer)
    ld.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)
    return layer


def icon_button(draw, cx, cy, kind, alpha=235):
    """画一个 26px 的图标按钮（不追求像素级还原，只要市场预览看得懂）。"""
    s = 11
    col = (225, 240, 252, alpha)
    if kind == "prev":
        draw.polygon([(cx - 6, cy - s), (cx - 6, cy + s), (cx + 3, cy)], fill=col)
        draw.rectangle([cx + 4, cy - s, cx + 7, cy + s], fill=col)
    elif kind == "next":
        draw.polygon([(cx + 6, cy - s), (cx + 6, cy + s), (cx - 3, cy)], fill=col)
        draw.rectangle([cx - 7, cy - s, cx - 4, cy + s], fill=col)
    elif kind == "play":
        draw.polygon([(cx - 5, cy - s), (cx - 5, cy + s), (cx + 7, cy)], fill=col)
    elif kind == "pin":
        draw.ellipse([cx - 4, cy - 9, cx + 4, cy - 1], outline=col, width=2)
        draw.line([(cx, cy - 1), (cx, cy + 8)], fill=col, width=2)
    elif kind == "close":
        draw.line([(cx - 6, cy - 6), (cx + 6, cy + 6)], fill=col, width=2)
        draw.line([(cx - 6, cy + 6), (cx + 6, cy - 6)], fill=col, width=2)
    elif kind == "loop":
        draw.arc([cx - 8, cy - 8, cx + 8, cy + 8], 30, 300, fill=col, width=2)
        draw.polygon([(cx + 7, cy - 8), (cx + 11, cy - 2), (cx + 4, cy - 3)], fill=col)
    elif kind == "monitor":
        draw.rounded_rectangle([cx - 9, cy - 8, cx + 9, cy + 4], radius=2, outline=col, width=2)
        draw.line([(cx, cy + 4), (cx, cy + 8)], fill=col, width=2)
        draw.line([(cx - 5, cy + 8), (cx + 5, cy + 8)], fill=col, width=2)
    elif kind == "window":
        draw.rounded_rectangle([cx - 9, cy - 8, cx + 9, cy + 8], radius=2, outline=col, width=2)
        draw.rectangle([cx - 5, cy - 4, cx + 5, cy + 4], outline=col, width=1)
    elif kind == "layout":
        draw.line([(cx - 8, cy - 6), (cx + 2, cy - 6)], fill=col, width=2)
        draw.line([(cx - 8, cy + 1), (cx + 4, cy + 1)], fill=(125, 211, 252, 255), width=2)
        draw.line([(cx - 8, cy + 8), (cx + 2, cy + 8)], fill=col, width=2)
    elif kind == "playlist":
        for i, yy in enumerate((-6, 0, 6)):
            draw.line([(cx - 8, cy + yy), (cx + 1, cy + yy)], fill=col, width=2)
            draw.ellipse([cx + 3, cy + yy - 2, cx + 7, cy + yy + 2], fill=col)


# ---------------------------------------------------------------- 桌面歌词窗口
DX, DY, DW, DH = 120, 452, 640, 180
shadow = panel((DX - 6, DY + 8, DX + DW + 6, DY + DH + 14), 22, (0, 0, 0, 90), None)
shadow = shadow.filter(ImageFilter.GaussianBlur(14))
canvas = Image.alpha_composite(canvas, shadow)
canvas = Image.alpha_composite(
    canvas,
    panel((DX, DY, DX + DW, DY + DH), 18, (8, 22, 36, 150), (125, 211, 252, 46)),
)

# ---------------------------------------------------------------- 悬浮窗歌词窗口
PX, PY, PW, PH = 700, 92, 500, 300
shadow = panel((PX - 6, PY + 10, PX + PW + 6, PY + PH + 16), 24, (0, 0, 0, 110), None)
shadow = shadow.filter(ImageFilter.GaussianBlur(16))
canvas = Image.alpha_composite(canvas, shadow)
canvas = Image.alpha_composite(
    canvas,
    panel((PX, PY, PX + PW, PY + PH), 20, (8, 22, 36, 165), (125, 211, 252, 48)),
)

overlay = Image.new('RGBA', (W, H), (0, 0, 0, 0))
d = ImageDraw.Draw(overlay)

def blend_text(xy, text, fnt, color):
    d.text(xy, text, font=fnt, fill=color)

# --- 桌面歌词控制条：左侧 5 个、正中固定、右侧 3 个
ty = DY + 22
for i, kind in enumerate(['prev', 'play', 'next', 'layout', 'window']):
    icon_button(d, DX + 34 + i * 34, ty, kind, 225)
icon_button(d, DX + DW // 2, ty, 'pin', 245)
for i, kind in enumerate(['loop', 'monitor', 'close']):
    icon_button(d, DX + DW - 34 - (2 - i) * 34, ty, kind, 225)

f_line = font(YAHEI_BOLD, 38)
f_sub = font(YAHEI, 27)
line = '在模糊雨幕中曾一次次回首'
sub = '在模糊雨幕中一次次回首'
lw = d.textlength(line, font=f_line)
d.text((DX + DW / 2 - lw / 2 + 1, DY + 79), line, font=f_line, fill=(0, 0, 0, 150))
d.text((DX + DW / 2 - lw / 2, DY + 78), line, font=f_line, fill=(255, 255, 255, 255))
sw = d.textlength(sub, font=f_sub)
d.text((DX + DW / 2 - sw / 2, DY + 128), sub, font=f_sub, fill=(255, 255, 255, 210))

# --- 悬浮窗：顶部键、左音量、右按钮列
icon_button(d, PX + PW // 2, PY + 22, 'monitor', 230)
icon_button(d, PX + PW - 26, PY + 22, 'close', 230)

rail_x = PX + 26
d.rounded_rectangle([rail_x - 2, PY + 52, rail_x + 2, PY + PH - 24], radius=2, fill=(255, 255, 255, 40))
d.rounded_rectangle([rail_x - 2, PY + 52, rail_x + 2, PY + 176], radius=2, fill=(125, 211, 252, 200))
d.ellipse([rail_x - 6, PY + 170, rail_x + 6, PY + 182], fill=(240, 250, 255, 245))

for i, kind in enumerate(['monitor', 'window', 'layout', 'playlist', 'loop', 'prev', 'play', 'next']):
    yy = PY + 54 + i * 30
    d.rounded_rectangle([PX + PW - 40, yy - 11, PX + PW - 16, yy + 11], radius=8,
                        fill=(255, 255, 255, 14), outline=(255, 255, 255, 26))
    icon_button(d, PX + PW - 28, yy, kind, 218)

rows = [
    ('穿行于匆匆过客之中模糊了目的', 0.40, 21),
    ('泪眼中簇拥墨色背影纷纷地远去', 0.58, 23),
    ('在模糊雨幕中曾一次次回首', 1.0, 29),
    ('仍忆起与你一同歌唱的那个路口', 0.64, 23),
    ('倾诉着喜悦或悲伤心情毫无保留', 0.42, 21),
]
text_x0 = PX + 48
text_x1 = PX + PW - 64
y = PY + 52
for text, alpha, size in rows:
    f = font(YAHEI_BOLD if alpha >= 1.0 else YAHEI, size)
    tw = d.textlength(text, font=f)
    cx = (text_x0 + text_x1) / 2
    if alpha >= 1.0:
        d.rounded_rectangle([cx - tw / 2 - 12, y - 6, cx + tw / 2 + 12, y + size + 8],
                            radius=10, fill=(125, 211, 252, 26))
    d.text((cx - tw / 2 + 1, y + 1), text, font=f, fill=(0, 0, 0, int(140 * alpha)))
    d.text((cx - tw / 2, y), text, font=f, fill=(255, 255, 255, int(255 * alpha)))
    y += size + 16

canvas = Image.alpha_composite(canvas, overlay)

# ---------------------------------------------------------------- 输出
out = canvas.convert("RGB")
out.save(OUT, "PNG", optimize=True)

size = os.path.getsize(OUT)
print(f"saved {os.path.abspath(OUT)}  {out.width}x{out.height}  {size} bytes")
