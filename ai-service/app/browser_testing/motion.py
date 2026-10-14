"""Bound native typing work without splitting common Unicode graphemes."""
import math
import unicodedata


def typing_plan(text, atomic=False):
    if not text:
        return [], 0
    if atomic:
        return [text], 0
    clusters = []
    regional = 0
    for char in text:
        code = ord(char)
        flag = 0x1F1E6 <= code <= 0x1F1FF
        joined = (unicodedata.combining(char) or unicodedata.category(char) in {'Mn', 'Me'} or
                  char == '\u200d' or 0xFE00 <= code <= 0xFE0F or
                  0x1F3FB <= code <= 0x1F3FF or (clusters and clusters[-1].endswith('\u200d')) or
                  (flag and regional % 2 == 1) or (char == '\n' and clusters and clusters[-1] == '\r'))
        if clusters and joined:
            clusters[-1] += char
        else:
            clusters.append(char)
        regional = regional + 1 if flag else 0
    # At most 40 CDP insertions, ~30 updates/s, at most 1.3s of intentional pacing.
    # Large source documents use batches instead of thousands of round trips.
    count = min(40, max(1, math.ceil(len(clusters) / 2)))
    size = math.ceil(len(clusters) / count)
    chunks = [''.join(clusters[i:i + size]) for i in range(0, len(clusters), size)]
    return chunks, .034
