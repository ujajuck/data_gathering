"""렌더 서버(계약 §5): Reader `render` 스트림 → 밴드 캐시 → 창(window) 응답.

`renderer_version`이 바뀌면 캐시 디렉터리 이름이 달라져 옛 캐시는 시작 시 정리된다(cache.py).
"""

RENDERER_VERSION = "openpyxl-simplified/3"
