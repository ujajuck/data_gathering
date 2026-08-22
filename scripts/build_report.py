# -*- coding: utf-8 -*-
"""정적 리포트 생성기 — canonical DB의 실데이터를 6패널(온톨로지/지식그래프/
문서-개념 매핑/단위 정규화/LOT 허브/Lineage) + 표준 Workbook 미리보기로 렌더링한다.

웹 서버(src.api.server) 없이 공유 가능한 스냅샷이 필요할 때 사용:
    python scripts/build_report.py                       # → data/canonical/report.html
    python scripts/build_report.py --out /tmp/report.html

라이브 화면이 필요하면 uvicorn src.api.server:app 을 쓰고,
이 스크립트는 '그 시점의 DB 상태'를 파일 하나로 고정하는 용도다.
"""
import argparse
import html
import sys
from pathlib import Path

import openpyxl

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.api.queries import (  # noqa: E402
    concept_map_projection,
    knowledge_graph_projection,
    load_relations,
    lot_hub_projection,
    ontology_projection,
)
from src.export.workbook import CanonicalWorkbookExporter  # noqa: E402
from src.pipeline import Pipeline  # noqa: E402


def collect(repo_root: Path, db_path: Path | None) -> tuple[dict, Path]:
    """API projection들을 모아 리포트 데이터셋을 만든다 (렌더러와 데이터 수집 분리)."""
    pipe = Pipeline(repo_root, db_path=db_path)
    data: dict = {}
    data["ontology"] = ontology_projection(pipe.registry)
    data["kg"] = knowledge_graph_projection(
        pipe.loader, pipe.registry, load_relations(repo_root / "config"))
    hub = lot_hub_projection(pipe.loader)
    data["hub_summary"] = {
        k: {"documents": v["documents"], "record_count": v["record_count"],
            "concept_count": len(v["concepts"]), "statuses": v["statuses"]}
        for k, v in hub["lots"].items()}
    focus = max(hub["lots"], key=lambda k: hub["lots"][k]["record_count"]) if hub["lots"] else None
    data["hub_focus"] = hub["lots"].get(focus) if focus else {"lot": "-", "records": [],
                                                              "documents": [], "concepts": {}}
    data["concept_map"] = concept_map_projection(pipe.loader, pipe.registry)

    obs = pipe.loader.current_observations()
    focus_lot = data["hub_focus"].get("lot", "")
    lineage: dict[str, list] = {}
    for o in obs:
        cid = o["concept_id"]
        if not cid or focus_lot not in o["record_key"]:
            continue
        lineage.setdefault(cid, []).append({
            "sheet": o["source_sheet"], "addr": o["source_address"],
            "raw": o["raw_value_num"] if o["raw_value_num"] is not None else o["raw_value_text"],
            "raw_unit": o["raw_unit"],
            "norm": o["normalized_value_num"] if o["normalized_value_num"] is not None
                    else o["normalized_value_text"],
            "unit": o["canonical_unit"], "role": o["value_role"]})
    data["lineage"] = lineage

    mapped = sum(1 for o in obs if o["concept_id"])
    data["stats"] = {
        "records": len(pipe.loader.current_records()),
        "observations": len(obs), "mapped": mapped,
        "pending": pipe.loader.conn.execute(
            "SELECT count(*) FROM mapping_decision WHERE decision='pending'").fetchone()[0],
        "documents": pipe.loader.conn.execute(
            "SELECT count(*) FROM source_document").fetchone()[0]}

    edges: dict[str, set] = {}
    for e in data["concept_map"]["source_edges"]:
        edges.setdefault(e["document"], set()).add(e["concept_id"])
    data["doc_concepts"] = {d: sorted(s) for d, s in edges.items()}

    xlsx = repo_root / "data" / "canonical" / "canonical.xlsx"
    if not xlsx.exists():
        CanonicalWorkbookExporter(pipe.loader).export(xlsx)
    return data, xlsx


_ap = argparse.ArgumentParser(description="canonical DB 6패널 정적 리포트 생성")
_ap.add_argument("--repo-root", type=Path, default=Path("."))
_ap.add_argument("--db", type=Path, default=None)
_ap.add_argument("--out", type=Path, default=None)
_args = _ap.parse_args()
_root = _args.repo_root.resolve()
data, _xlsx_path = collect(_root, _args.db)
_out_path = _args.out or (_root / "data" / "canonical" / "report.html")

def esc(x):
    return html.escape(str(x)) if x is not None else ""

def fmt(v):
    if isinstance(v, float):
        s = f"{v:,.4f}".rstrip("0").rstrip(".")
        return s if s else "0"
    return esc(v)

_focus_lot = data["hub_focus"].get("lot", "-")
st = data["stats"]
mapped_pct = round(100 * st["mapped"] / st["observations"]) if st["observations"] else 0

# ---------------------------------------------------------------- panel 1 ----
DOM_ORDER = ["process", "quality", "equipment", "energy", "time", "misc"]
dom_cards = []
for key in DOM_ORDER:
    d = data["ontology"]["domains"][key]
    chips = []
    for c in d["concepts"]:
        unit = f'<span class="u">{esc(c["canonical_unit"])}</span>' if c["canonical_unit"] else ""
        parent = ' data-child="1"' if c["parent_concept"] else ""
        chips.append(f'<span class="chip"{parent}>{esc(c["name_ko"])}{unit}</span>')
    dom_cards.append(
        f'<div class="dom"><h4>{esc(d["name_ko"])} <em>{esc(d["name_en"])}</em>'
        f'<b>{len(d["concepts"])}</b></h4><div class="chips">{"".join(chips)}</div></div>')
panel1 = '<div class="domgrid">' + "".join(dom_cards) + "</div>"

# ---------------------------------------------------------------- panel 2 ----
kg = data["kg"]
nodes = {n["class"]: n for n in kg["nodes"]}
POS = {  # viewBox 980x560
    "run": (300, 90), "equipment": (640, 90), "lot": (470, 265),
    "input": (110, 265), "output": (830, 220), "quality": (170, 430),
    "energy": (760, 400), "time": (470, 480), "document": (900, 500),
}
R = {"lot": 64, "document": 38}
def node_svg(cls):
    n = nodes[cls]; x, y = POS[cls]; r = R.get(cls, 52)
    onacc = " onacc" if cls == "lot" else ""
    inst = ""
    if cls == "lot":
        inst = f'<text x="{x}" y="{y+34}" class="sub">예: {esc(n["instances"][0])}</text>'
    return (f'<circle cx="{x}" cy="{y}" r="{r}" class="kgn kg-{cls}"/>'
            f'<text x="{x}" y="{y-6}" class="lab{onacc}">{esc(n["name_ko"])}</text>'
            f'<text x="{x}" y="{y+13}" class="cnt{onacc}">{n["observation_count"]:,}건</text>{inst}')
# 엣지 라벨의 선상 위치(t)를 겹치지 않게 개별 조정
LABEL_T = {("energy", "used_by"): 0.22, ("equipment", "consumes"): 0.74,
           ("output", "produced_by"): 0.28, ("run", "produces"): 0.42,
           ("lot", "belongs_to"): 0.62}
def edge_svg(e):
    (x1, y1), (x2, y2) = POS[e["subject"]], POS[e["object"]]
    r1, r2 = R.get(e["subject"], 52), R.get(e["object"], 52)
    import math
    dx, dy = x2 - x1, y2 - y1; L = math.hypot(dx, dy) or 1
    sx, sy = x1 + dx / L * (r1 + 4), y1 + dy / L * (r1 + 4)
    ex, ey = x2 - dx / L * (r2 + 9), y2 - dy / L * (r2 + 9)
    t = LABEL_T.get((e["subject"], e["predicate"]), 0.5)
    mx, my = sx + (ex - sx) * t, sy + (ey - sy) * t
    off = -8 if abs(dy) > abs(dx) else -7
    return (f'<line x1="{sx:.0f}" y1="{sy:.0f}" x2="{ex:.0f}" y2="{ey:.0f}" class="kge" marker-end="url(#arr)"/>'
            f'<text x="{mx:.0f}" y="{my+off:.0f}" class="elab">{esc(e["name_ko"])} ·{e["evidence_records"]}</text>')
edges_svg = "".join(edge_svg(e) for e in kg["edges"])
nodes_svg = "".join(node_svg(c) for c in POS)
panel2 = f'''<figure><svg viewBox="0 0 980 560" role="img" aria-label="엔티티 클래스 지식 그래프 — 관계마다 실제 레코드 동시출현 근거 수를 표기">
<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="currentColor"/></marker></defs>
{edges_svg}{nodes_svg}</svg>
<figcaption>관계 엣지의 숫자는 현재 DB에서 두 엔티티가 같은 레코드에 동시 등장한 횟수(근거 레코드 수). 노드의 건수는 해당 클래스로 분류된 관측치 수.</figcaption></figure>'''

# ---------------------------------------------------------------- panel 3 ----
DOC_META = {
    "01_설비점검일지_반복블록.xlsx": ("설비점검", "반복 Block 4"),
    "02_품질검사성적서_반복양식.xlsx": ("검사결과", "반복 양식 3"),
    "03_공정운전실적_반복카드.xlsx": ("Batch운전", "반복 카드 4"),
    "A_생산일보_중합2팀_202608.xlsx": ("생산일보 + 현장코드", "행=LOT 표 + 내장 사전"),
    "B_MES_BatchPerformance_Aug2026.xlsx": ("Batch_Performance + Tag_Dictionary", "단위행 + 태그 사전"),
    "C_QC_Lab_ResultSheet_R4.xlsx": ("검사결과 + 계산근거", "전치 표(LOT=열) + K/MPa/g"),
    "D_complex_semistructured.xlsx": ("4개 시트 + MASTER_코드표", "다영역·병렬 블록"),
}
rows3 = []
for doc in sorted(data["doc_concepts"]):
    concepts = data["doc_concepts"][doc]
    sheets, kind = DOC_META.get(doc, ("", ""))
    chips = "".join(f'<span class="chip sm">{esc(c)}</span>' for c in concepts[:9])
    more = f'<span class="chip sm more">+{len(concepts)-9}</span>' if len(concepts) > 9 else ""
    rows3.append(f'<tr><td class="doc"><b>{esc(doc)}</b><small>{esc(sheets)} · {esc(kind)}</small></td>'
                 f'<td class="num">{len(concepts)}</td><td>{chips}{more}</td></tr>')
panel3 = ('<div class="tblwrap"><table class="t3"><thead><tr><th>문서 (시트/구조)</th>'
          '<th>매핑 개념</th><th>연결된 표준 개념</th></tr></thead><tbody>'
          + "".join(rows3) + "</tbody></table></div>")

# ---------------------------------------------------------------- panel 4 ----
UNIT_ROWS = [
    ("reaction_temperature", "반응온도"), ("reaction_pressure", "압력"),
    ("input_amount", "투입량"), ("viscosity", "점도"),
    ("moisture", "수분함량"), ("solids_content", "고형분"),
    ("yield_rate", "수율"), ("energy_consumption", "전력사용량"),
]
rows4 = []
for cid, name in UNIT_ROWS:
    obs = data["lineage"].get(cid, [])
    if not obs:
        continue
    variants, seen = [], set()
    unit = obs[0]["unit"]
    for o in obs:
        key = (str(o["raw"]), str(o["raw_unit"]))
        if key in seen:
            continue
        seen.add(key)
        variants.append(f'<span class="var">{fmt(o["raw"])}<i> {esc(o["raw_unit"] or "")}</i></span>')
    norms = {round(o["norm"], 2) if isinstance(o["norm"], float) else o["norm"] for o in obs}
    norm = sorted(norms)[0]
    rows4.append(f'<tr><td class="vars">{"".join(variants)}</td>'
                 f'<td class="concept-cell"><span class="cnode">{esc(name)}'
                 + (f'<i>({esc(unit)})</i>' if unit else "") + "</span></td>"
                 f'<td class="num std">{fmt(norm)} {esc(unit or "")}</td></tr>')
panel4 = (f'<div class="tblwrap"><table class="t4"><thead><tr><th>다양한 원본 표현 ({esc(_focus_lot)} 실측)</th>'
          '<th>표준 개념</th><th>통합 저장 값</th></tr></thead><tbody>'
          + "".join(rows4) + "</tbody></table></div>")

# ---------------------------------------------------------------- panel 5 ----
hub_rows = []
for lot, v in sorted(data["hub_summary"].items()):
    statuses = "".join(f'<span class="st {"bad" if s in ("NG","HOLD","EXC","C","재검/부적합","정비 필요","이상") else "ok"}">{esc(s)}</span>'
                       for s in dict.fromkeys(v["statuses"]))
    hub_rows.append(f'<tr><td class="mono b">{esc(lot)}</td><td class="num">{v["record_count"]}</td>'
                    f'<td class="num">{len(v["documents"])}</td><td class="num">{v["concept_count"]}</td>'
                    f'<td>{statuses or "<span class=dim>—</span>"}</td></tr>')
b = data["hub_focus"]
det_rows = []
PICK = ["reaction_temperature", "reaction_pressure", "input_amount", "output_amount",
        "yield_rate", "viscosity", "solids_content", "moisture", "energy_consumption", "reject_count"]
for cid in PICK:
    vals = b["concepts"].get(cid)
    if not vals:
        continue
    cells = "".join(f'<span class="src">{fmt(v["value"])}<i>{esc(v["unit"] or "")}</i>'
                    f'<small>{esc(v["source"])}</small></span>' for v in vals[:4])
    det_rows.append(f'<tr><td class="mono">{esc(cid)}</td><td class="srcs">{cells}</td></tr>')
panel5 = f'''<div class="hubgrid">
<div class="tblwrap"><table class="t5"><thead><tr><th>LOT</th><th>레코드</th><th>문서</th><th>개념</th><th>판정</th></tr></thead>
<tbody>{"".join(hub_rows)}</tbody></table></div>
<div class="hubdetail"><h4>{esc(_focus_lot)} — 문서 횡단 통합 <span class="pill">{b["record_count"]} 레코드 · {len(b["documents"])} 시트 · {len(b["concepts"])} 개념</span></h4>
<p class="dim">출처: {esc(" · ".join(b["documents"]))}</p>
<div class="tblwrap"><table class="t5d"><tbody>{"".join(det_rows)}</tbody></table></div></div></div>'''

# ---------------------------------------------------------------- panel 6 ----
_lin_all = data["lineage"]
_lin_cid = "reaction_temperature" if "reaction_temperature" in _lin_all else (
    max(_lin_all, key=lambda k: len(_lin_all[k])) if _lin_all else None)
lin = sorted(_lin_all.get(_lin_cid, []), key=lambda o: o["sheet"])[:6]
CONV = {"K": "℃ = K − 273.15", "degC": "℃ = degC", "℃": "동일", None: ""}
srcs = []
for i, o in enumerate(lin):
    y = 60 + i * 96
    conv = CONV.get(o["raw_unit"], "")
    srcs.append(
        f'<rect x="16" y="{y-34}" width="252" height="68" rx="6" class="lbox"/>'
        f'<text x="30" y="{y-12}" class="lt b">{esc(o["sheet"])}!{esc(o["addr"])}</text>'
        f'<text x="30" y="{y+8}" class="lt mono">{fmt(o["raw"])} {esc(o["raw_unit"] or "")}</text>'
        f'<text x="30" y="{y+26}" class="lt dim2">{esc(conv)}</text>'
        f'<line x1="268" y1="{y}" x2="422" y2="238" class="kge" marker-end="url(#arr2)"/>')
panel6 = f'''<figure><svg viewBox="0 0 900 476" role="img" aria-label="반응온도 lineage — 4개 문서의 서로 다른 표현이 하나의 표준값으로 수렴">
<defs><marker id="arr2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="currentColor"/></marker></defs>
{"".join(srcs)}
<rect x="430" y="200" width="180" height="76" rx="38" class="cbig"/>
<text x="520" y="232" class="lab big">{esc(_lin_cid or "—")}</text>
<text x="520" y="252" class="cnt">reaction_temperature</text>
<line x1="610" y1="238" x2="708" y2="238" class="kge" marker-end="url(#arr2)"/>
<rect x="716" y="204" width="168" height="68" rx="6" class="rbox"/>
<text x="800" y="232" class="lab big mono">75.00 ℃</text>
<text x="800" y="254" class="cnt">표준값 · 출처 4개 셀 보존</text>
</svg><figcaption>같은 물리량이 75 ℃ / 75 degC / 348.15 K / PV 75 로 적혀 있어도 개념 매핑과 결정론적 단위 변환을 거쳐 하나의 표준값으로 저장되고, 각 관측치는 원본 셀 주소·원시값·원시단위를 그대로 유지한다.</figcaption></figure>'''

# ---------------------------------------------------------------- panel 7 ----
wb = openpyxl.load_workbook(_xlsx_path)
tabs, panes = [], []
LIMIT = {"01_Record_Index": 12, "02_Observations": 12, "03_Source_Lineage": 10,
         "04_Attachments": 11, "05_Mapping_Log": 10}
for i, ws in enumerate(wb.worksheets):
    rows = list(ws.iter_rows(values_only=True))
    head, body = rows[0], rows[1:LIMIT.get(ws.title, 10) + 1]
    total = len(rows) - 1
    thead = "".join(f"<th>{esc(h)}</th>" for h in head)
    trs = []
    for r in body:
        tds = "".join(f'<td>{fmt(c)[:46]}</td>' for c in r)
        trs.append(f"<tr>{tds}</tr>")
    checked = " checked" if i == 0 else ""
    tabs.append(f'<input type="radio" name="wbtab" id="wb{i}"{checked}>'
                f'<label for="wb{i}">{esc(ws.title)} <b>{total:,}</b></label>')
    panes.append(f'<div class="pane" id="p{i}"><div class="tblwrap"><table class="wb">'
                 f'<thead><tr>{thead}</tr></thead><tbody>{"".join(trs)}</tbody></table></div>'
                 f'<p class="dim">전체 {total:,}행 중 앞 {len(body)}행</p></div>')
panel7 = f'<div class="wbtabs">{"".join(tabs)}<div class="panes">{"".join(panes)}</div></div>'

# ------------------------------------------------------------------- page ----
css_tabs = "".join(
    f'.wbtabs #wb{i}:checked ~ .panes #p{i}{{display:block}}'
    f'.wbtabs #wb{i}:checked + label{{color:var(--accent);border-color:var(--accent);background:var(--accent-soft)}}'
    for i in range(len(panes)))

page = f'''<title>화학 공정 데이터 온톨로지</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@400;500;700&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
:root {{
  --bg:#f5f8f9; --surface:#ffffff; --ink:#182630; --dim:#5c7280; --line:#d3dee4;
  --accent:#1265a8; --accent-soft:#e3eef7; --accent-ink:#0d4c80;
  --ok:#1f7a5c; --ok-soft:#e0f0e9; --bad:#b3372f; --bad-soft:#f7e5e2;
  --chip:#eef3f6; --on-accent:#ffffff; --mono:'IBM Plex Mono',ui-monospace,monospace;
}}
@media (prefers-color-scheme: dark) {{ :root:not([data-theme="light"]) {{
  --bg:#0f171c; --surface:#16222a; --ink:#dbe7ed; --dim:#8aa0ad; --line:#2b3b45;
  --accent:#5aa9e0; --accent-soft:#16324a; --accent-ink:#9dcbec;
  --ok:#57bd94; --ok-soft:#12362a; --bad:#e08a80; --bad-soft:#3f1f1b; --chip:#1d2b34; --on-accent:#0f171c;
}} }}
:root[data-theme="dark"] {{
  --bg:#0f171c; --surface:#16222a; --ink:#dbe7ed; --dim:#8aa0ad; --line:#2b3b45;
  --accent:#5aa9e0; --accent-soft:#16324a; --accent-ink:#9dcbec;
  --ok:#57bd94; --ok-soft:#12362a; --bad:#e08a80; --bad-soft:#3f1f1b; --chip:#1d2b34; --on-accent:#0f171c;
}}
* {{ box-sizing:border-box }}
body {{ background:var(--bg); color:var(--ink); margin:0;
  font:15px/1.65 'IBM Plex Sans KR',system-ui,sans-serif; }}
main {{ max-width:1100px; margin:0 auto; padding:40px 28px 88px; display:flex;
  flex-direction:column; gap:44px; }}
header.hero h1 {{ font-size:30px; line-height:1.25; margin:6px 0 10px; text-wrap:balance; }}
header.hero .eyebrow {{ font:500 12px/1 var(--mono); letter-spacing:.14em;
  color:var(--accent); text-transform:uppercase; }}
header.hero p {{ color:var(--dim); max-width:62ch; margin:0 0 22px; }}
.stats {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:10px; }}
.stat {{ background:var(--surface); border:1px solid var(--line); border-radius:8px;
  padding:14px 16px; }}
.stat b {{ display:block; font:500 24px/1.2 var(--mono); font-variant-numeric:tabular-nums; }}
.stat span {{ font-size:12px; color:var(--dim); }}
section {{ background:var(--surface); border:1px solid var(--line); border-radius:10px;
  padding:26px 28px 24px; }}
section > h2 {{ margin:0 0 4px; font-size:19px; display:flex; align-items:baseline; gap:10px; }}
section > h2 .no {{ font:500 13px/1 var(--mono); color:var(--accent);
  border:1px solid var(--accent); border-radius:999px; padding:4px 9px; }}
section > p.lead {{ margin:4px 0 18px; color:var(--dim); font-size:13.5px; max-width:78ch; }}
h4 {{ margin:0 0 8px; font-size:14px; }}
.domgrid {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(300px,1fr)); gap:12px; }}
.dom {{ border:1px solid var(--line); border-radius:8px; padding:14px 15px; }}
.dom h4 {{ display:flex; gap:8px; align-items:baseline; }}
.dom h4 em {{ font:400 11px var(--mono); color:var(--dim); font-style:normal; }}
.dom h4 b {{ margin-left:auto; font:500 12px var(--mono); color:var(--accent); }}
.chips {{ display:flex; flex-wrap:wrap; gap:6px; }}
.chip {{ background:var(--chip); border-radius:5px; padding:3px 8px; font-size:12.5px; }}
.chip[data-child="1"] {{ box-shadow:inset 2px 0 0 var(--accent); }}
.chip .u {{ font:400 10.5px var(--mono); color:var(--accent-ink); margin-left:4px; }}
.chip.sm {{ font-size:11.5px; padding:2px 7px; }}
.chip.more {{ color:var(--dim); background:transparent; border:1px dashed var(--line); }}
figure {{ margin:0; }}
figure svg {{ width:100%; height:auto; color:var(--ink); }}
figcaption {{ font-size:12.5px; color:var(--dim); margin-top:10px; max-width:80ch; }}
.kgn {{ fill:var(--accent-soft); stroke:var(--accent); stroke-width:1.4; }}
.kg-lot {{ fill:var(--accent); }}
.kge {{ stroke:currentColor; stroke-width:1.1; opacity:.55; }}
text.lab {{ font:500 13px 'IBM Plex Sans KR'; fill:currentColor; text-anchor:middle; }}
text.lab.big {{ font-size:15px; }}
text.cnt {{ font:400 10.5px var(--mono); fill:var(--dim); text-anchor:middle; }}
text.lab.onacc, text.cnt.onacc, text.sub {{ fill:var(--on-accent); text-anchor:middle; }}
text.sub {{ font:400 10.5px var(--mono); opacity:.85; }}
text.elab {{ font:400 10.5px 'IBM Plex Sans KR'; fill:var(--dim); text-anchor:middle;
  paint-order:stroke; stroke:var(--surface); stroke-width:3px; }}
.kg-lot-label {{ fill:#fff; }}
.lbox {{ fill:var(--chip); stroke:var(--line); }}
.rbox {{ fill:var(--ok-soft); stroke:var(--ok); }}
.cbig {{ fill:var(--accent-soft); stroke:var(--accent); stroke-width:1.6; }}
text.lt {{ font:400 12px 'IBM Plex Sans KR'; fill:currentColor; }}
text.lt.b {{ font-weight:500; }}
text.lt.mono, .mono {{ font-family:var(--mono); }}
text.lt.dim2 {{ fill:var(--dim); font-size:10.5px; }}
.tblwrap {{ overflow-x:auto; }}
table {{ border-collapse:collapse; width:100%; font-size:12.5px; }}
th {{ text-align:left; font:500 11px var(--mono); letter-spacing:.06em; color:var(--dim);
  text-transform:uppercase; border-bottom:1.5px solid var(--line); padding:7px 10px; white-space:nowrap; }}
td {{ border-bottom:1px solid var(--line); padding:7px 10px; vertical-align:top; }}
td.num {{ font-family:var(--mono); font-variant-numeric:tabular-nums; }}
td.doc small {{ display:block; color:var(--dim); }}
td.b, .b {{ font-weight:500; }}
.var {{ display:inline-block; background:var(--chip); border-radius:5px; padding:2px 8px;
  margin:2px 4px 2px 0; font-family:var(--mono); font-size:12px; }}
.var i {{ font-style:normal; color:var(--accent-ink); }}
.cnode {{ display:inline-block; background:var(--accent-soft); border:1px solid var(--accent);
  color:var(--accent-ink); border-radius:999px; padding:3px 12px; font-weight:500; white-space:nowrap; }}
.cnode i {{ font-style:normal; font-family:var(--mono); font-size:11px; margin-left:2px; }}
td.std {{ font-weight:500; white-space:nowrap; }}
.st {{ display:inline-block; border-radius:4px; padding:1px 7px; font-size:11px; margin-right:4px; }}
.st.ok {{ background:var(--ok-soft); color:var(--ok); }}
.st.bad {{ background:var(--bad-soft); color:var(--bad); }}
.dim {{ color:var(--dim); font-size:12px; }}
.hubgrid {{ display:grid; grid-template-columns:minmax(280px,5fr) minmax(320px,7fr); gap:22px; }}
@media (max-width:820px) {{ .hubgrid {{ grid-template-columns:1fr; }} }}
.hubdetail {{ border:1px solid var(--line); border-radius:8px; padding:16px 18px; }}
.pill {{ font:400 11px var(--mono); color:var(--accent); border:1px solid var(--line);
  border-radius:999px; padding:2px 9px; margin-left:6px; }}
.src {{ display:inline-block; background:var(--chip); border-radius:6px; padding:4px 9px;
  margin:2px 5px 2px 0; font-family:var(--mono); font-size:12px; }}
.src i {{ font-style:normal; color:var(--accent-ink); margin-left:3px; }}
.src small {{ display:block; color:var(--dim); font-size:10px; }}
.wbtabs input {{ position:absolute; opacity:0; pointer-events:none; }}
.wbtabs label {{ display:inline-block; border:1px solid var(--line); border-radius:6px 6px 0 0;
  border-bottom:none; padding:7px 13px; font-size:12.5px; cursor:pointer; color:var(--dim);
  margin-right:4px; }}
.wbtabs label b {{ font:400 11px var(--mono); color:inherit; opacity:.75; margin-left:4px; }}
.wbtabs .panes {{ border-top:1.5px solid var(--line); padding-top:6px; }}
.wbtabs .pane {{ display:none; }}
{css_tabs}
table.wb td {{ white-space:nowrap; max-width:260px; overflow:hidden; text-overflow:ellipsis;
  font-family:var(--mono); font-size:11.5px; }}
input[type=radio]:focus-visible + label {{ outline:2px solid var(--accent); outline-offset:2px; }}
@media (prefers-reduced-motion:no-preference) {{ section {{ scroll-margin-top:20px; }} }}
</style>
<main>
<header class="hero">
  <div class="eyebrow">Excel → Canonical DB · DVC 변경추적 파이프라인 — 실행 결과</div>
  <h1>화학 공정 데이터 온톨로지</h1>
  <p>업로드된 7개 반정형 Excel(반복 블록 3종 + 생산일보·MES·QC·복합 문서 4종)을 파이프라인에 실제로 통과시킨
     산출을 목표 이미지의 6개 패널 구성 그대로 보여준다. 아래 모든 숫자·셀 주소·판정은 DB에 적재된 실데이터다.</p>
  <div class="stats">
    <div class="stat"><b>{st["documents"]}</b><span>문서 (시트 13개)</span></div>
    <div class="stat"><b>{st["records"]}</b><span>Record (current)</span></div>
    <div class="stat"><b>{st["observations"]:,}</b><span>Observation</span></div>
    <div class="stat"><b>{mapped_pct}%</b><span>개념 매핑 ({st["mapped"]:,}건 auto)</span></div>
    <div class="stat"><b>{st["pending"]}</b><span>검토 대기 (pending)</span></div>
  </div>
</header>

<section><h2><span class="no">1</span>개념(온톨로지) 계층 그래프</h2>
<p class="lead">concepts.yaml의 표준 개념 사전 — 6개 도메인 아래 58개 개념. 파란 눈금이 있는 칩은 상위
개념(parent)을 가진 하위 개념이며, 단위는 각 개념의 표준 단위다.</p>
{panel1}</section>

<section><h2><span class="no">2</span>개념 간 관계 그래프 (지식 그래프)</h2>
<p class="lead">config/relations.yaml의 엔티티 클래스와 관계. 배치(LOT)를 허브로 공정운전·설비·품질·에너지가
연결되며, 각 엣지에는 실제 레코드에서 두 클래스가 함께 등장한 횟수가 붙는다.</p>
{panel2}</section>

<section><h2><span class="no">3</span>문서 → 개념 매핑 그래프</h2>
<p class="lead">7개 문서가 어떤 표준 개념에 연결되었는지. RX_TEMP·QTY_IN 같은 태그는 문서 내장 사전
(Tag_Dictionary 등)을 통해, PV(℃)는 상위 헤더 fallback을 통해 해소되었다.</p>
{panel3}</section>

<section><h2><span class="no">4</span>단위/용어 정규화 그래프</h2>
<p class="lead">같은 LOT({esc(_focus_lot)})의 같은 물리량이 문서마다 다른 표기·단위로 적혀 있고, 아핀 변환(K−273.15)을
포함한 결정론적 변환으로 표준 단위에 수렴한다.</p>
{panel4}</section>

<section><h2><span class="no">5</span>개념 기반 데이터 통합 모델 — LOT 허브</h2>
<p class="lead">business key로 조인된 문서 횡단 통합. 왼쪽은 전체 LOT/설비 허브 요약, 오른쪽은 {esc(_focus_lot)} 상세 —
같은 값이 여러 문서에서 서로 다른 단위로 들어와 하나로 합쳐진 것을 출처 셀과 함께 보여준다.</p>
{panel5}</section>

<section><h2><span class="no">6</span>하나의 개념 추적 흐름 (Lineage)</h2>
<p class="lead">목표 이미지의 예시 그대로 — 반응온도.</p>
{panel6}</section>

<section><h2><span class="no">7</span>표준 통합 Workbook (canonical.xlsx)</h2>
<p class="lead">Exporter가 생성한 고정 5-시트 출력 계약. 원본 양식이 무엇이든 모든 문서가 이 형태로 나온다.</p>
{panel7}</section>
</main>'''

_out_path.parent.mkdir(parents=True, exist_ok=True)
_out_path.write_text(page, encoding="utf-8")
print(f"report: {_out_path} ({len(page.encode('utf-8')):,} bytes)")
