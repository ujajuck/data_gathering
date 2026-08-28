"""Build domain_kg.yaml from checksheet_tree.txt structure."""
import yaml
from pathlib import Path

# L1 categories: (id, ko, en, desc)
l1_categories = [
    ("domain_experiment", "실험기본정보", "Experiment Info", "실험 기본 정보"),
    ("domain_summary", "실험요약", "Experiment Summary", "실험 요약 정보"),
    ("domain_weighing", "칭량공정", "Weighing Process", "칭량 공정 정보"),
    ("domain_apex", "APEX공정", "APEX Process", "APEX 해쇄/분산 공정"),
    ("domain_apex_filter", "APEX해쇄필터", "APEX Crushing Filter", "APEX 해쇄필터 공정"),
    ("domain_final_filter", "최종필터공정", "Final Filter Process", "최종필터 공정"),
    ("domain_batch_inspection", "배치검사", "Batch Inspection", "배치 검사 (물성 기준)"),
    ("domain_stirring", "교반Table", "Stirring Table", "교반 Table 조건"),
    ("domain_calculation", "계산식", "Calculation", "첨가제 배합 계산식"),
    ("domain_input", "투입량", "Input Amount", "Checksheet 투입량"),
]

# L2 concepts: (id, ko, en, desc, type, dtype, unit, unit_dim, aliases)
l2_concepts = [
    # 실험기본정보
    ("title", "제목", "Title", "실험 제목", "identifier", "text", None, None,
     ["제목", "타이틀"]),
    ("material_code", "자료코드", "Material Code", "자료 코드 (MLCUA-*)", "identifier", "text", None, None,
     ["자료코드", "자료 코드", "Material Code", "MLCUA"]),
    ("input_date", "투입일", "Input Date", "투입 일자", "event_time", "text", None, "time",
     ["투입일", "투입일자", "Input Date"]),
    ("author", "작성자", "Author", "작성자", "identifier", "text", None, None,
     ["작성자", "Author", "담당자"]),

    # 실험요약
    ("lot_no", "LOT", "LOT Number", "LOT 번호", "identifier", "text", None, None,
     ["LOT", "LOT번호", "Lot No", "Lot No."]),
    ("powder", "Powder", "Powder", "파우더 정보", "measurement", "text", None, None,
     ["Powder", "파우더", "분말"]),
    ("binder_composition", "Binder조성", "Binder Composition", "바인더 조성 코드", "identifier", "text", None, None,
     ["Binder조성", "바인더조성", "Binder 조성"]),
    ("additive", "Additive", "Additive", "첨가제 코드", "identifier", "text", None, None,
     ["Additive", "첨가제", "첨가제코드"]),
    ("sr_ratio", "S/R비", "S/R Ratio", "Solid/Resin 비율", "measurement", "text", None, None,
     ["S/R비", "S/R", "SR비", "Solid/Resin"]),
    ("binder", "Binder", "Binder", "바인더 종류", "identifier", "text", None, None,
     ["Binder", "바인더"]),
    ("dispersant", "분산제", "Dispersant", "분산제 종류", "identifier", "text", None, None,
     ["분산제", "Dispersant", "BYK"]),
    ("solid_content", "고형분", "Solid Content", "고형분 비율", "measurement", "text", "%", "percentage",
     ["고형분", "Solid Content", "고형분율"]),
    ("solvent", "솔벤트", "Solvent", "용매 종류", "identifier", "text", None, None,
     ["솔벤트", "Solvent", "용매", "Ethanol", "에탄올"]),

    # 칭량공정 - 투입정보
    ("input_product", "투입제품", "Input Product", "투입 제품명", "identifier", "text", None, None,
     ["투입제품", "투입 제품", "Input Product"]),
    ("weight_target", "무게Target", "Weight Target", "목표 무게", "measurement", "text", "g", "mass",
     ["무게Target", "무게 Target", "목표무게", "Weight Target"]),
    ("tolerance", "공차", "Tolerance", "허용 공차", "measurement", "text", None, None,
     ["공차", "Tolerance", "허용범위"]),
    ("combination_detail", "조합내역", "Combination Detail", "조합 내역", "identifier", "text", None, None,
     ["조합내역", "조합 내역"]),
    ("input_lot_no", "투입LOT", "Input LOT", "투입 LOT 번호", "identifier", "text", None, None,
     ["LOT_No", "투입LOT", "Input LOT"]),

    # 점검정보 (공통)
    ("check_item", "체크항목", "Check Item", "점검/체크 항목명", "identifier", "text", None, None,
     ["체크항목", "체크 항목", "Check Item", "점검항목"]),
    ("target_value", "Target", "Target Value", "목표값", "measurement", "text", None, None,
     ["Target", "목표값", "Target Value"]),
    ("check_tolerance", "체크공차", "Check Tolerance", "체크 항목 공차", "measurement", "text", None, None,
     ["체크공차"]),

    # APEX 공정 특화
    ("material_name", "자재명", "Material Name", "자재 명", "identifier", "text", None, None,
     ["자재 명", "자재명", "Material Name"]),
    ("input_amount", "투입량", "Input Amount", "투입량", "measurement", "text", "g", "mass",
     ["투입량", "Input Amount"]),

    # APEX 점검 항목들
    ("tank_type", "TankType", "Tank Type", "탱크 타입", "identifier", "text", None, None,
     ["Tank Type", "Tank_TYPE", "탱크타입"]),
    ("slurry_temperature", "슬러리온도", "Slurry Temperature", "슬러리 온도", "measurement", "text", "℃", "temperature",
     ["슬러리온도", "Slurry 온도", "Slurry Temperature"]),
    ("cooling_water_temp", "냉각수온도", "Cooling Water Temp", "냉각수 온도", "measurement", "text", "℃", "temperature",
     ["냉각수온도", "냉각수 온도"]),
    ("rotor_rpm", "RotorRPM", "Rotor RPM", "로터 회전수", "measurement", "text", "rpm", "frequency",
     ["Rotor RPM", "RotorRPM", "로터RPM"]),
    ("flow_rate", "유량", "Flow Rate", "유량", "measurement", "text", None, None,
     ["유량", "Flow Rate"]),
    ("cylinder_pressure", "실린더압력", "Cylinder Pressure", "실린더 압력", "measurement", "text", "psi", "pressure",
     ["실린더압력", "Cylinder Pressure"]),
    ("oil_temperature", "오일온도", "Oil Temperature", "오일 온도", "measurement", "text", "℃", "temperature",
     ["오일온도", "Oil Temperature"]),
    ("pass_time", "1pass소요시간", "1-Pass Time", "1패스 소요 시간", "measurement", "text", None, "time",
     ["1pass 소요시간", "1pass소요시간"]),

    # 배치 검사 물성 기준
    ("inspection_category", "구분", "Inspection Category", "검사 구분", "identifier", "text", None, None,
     ["구분", "검사구분"]),
    ("inspection_target", "검사Target", "Inspection Target", "검사 목표값", "measurement", "text", None, None,
     ["검사 Target"]),
    ("inspection_tolerance", "검사공차", "Inspection Tolerance", "검사 공차", "measurement", "text", None, None,
     ["검사공차"]),
    ("inspection_unit", "검사결과단위", "Inspection Unit", "검사 결과 단위", "identifier", "text", None, None,
     ["검사결과_단위", "검사단위"]),

    # 물성 항목 (배치검사 구분값들)
    ("viscosity", "점도", "Viscosity", "점도 (cPs)", "measurement", "text", "cPs", "viscosity",
     ["점도", "Viscosity", "cPs"]),
    ("specific_gravity", "비중", "Specific Gravity", "비중", "measurement", "text", "g/cc", "density",
     ["비중", "Specific Gravity"]),
    ("solid_content_pct", "고형분율", "Solid Content %", "고형분 (%)", "measurement", "text", "%", "percentage",
     ["고형분", "고형분율"]),
    ("crushing_bet", "해쇄BET", "Crushing BET", "해쇄 BET 비표면적", "measurement", "text", "㎡/g", "specific_surface",
     ["해쇄BET", "해쇄 BET", "Crushing BET"]),
    ("final_bet", "최종BET", "Final BET", "최종 BET 비표면적", "measurement", "text", "㎡/g", "specific_surface",
     ["최종BET", "최종 BET", "Final BET"]),

    # 교반 Table
    ("sub_process", "세부공정", "Sub Process", "세부 공정명", "identifier", "text", None, None,
     ["세부공정", "세부 공정", "Sub Process"]),
    ("stirring_rpm", "교반RPM", "Stirring RPM", "교반 회전수", "measurement", "text", "rpm", "frequency",
     ["교반 RPM", "RPM", "교반RPM"]),

    # 계산식 (Sheet2)
    ("calc_item", "계산항목", "Calc Item", "계산식 항목명", "identifier", "text", None, None,
     ["항목", "계산항목"]),
    ("solute_powder", "용질파우더", "Solute Powder", "용질 중 파우더량", "measurement", "text", "g", "mass",
     ["파우더", "용질 파우더"]),
    ("solute_dispersant", "용질분산제", "Solute Dispersant", "용질 중 분산제량", "measurement", "text", "g", "mass",
     ["분산제", "용질 분산제"]),
    ("solute_binder", "용질바인더", "Solute Binder", "용질 중 바인더량", "measurement", "text", "g", "mass",
     ["바인더", "용질 바인더"]),
    ("solute_plasticizer", "용질가소제", "Solute Plasticizer", "용질 중 가소제량", "measurement", "text", "g", "mass",
     ["가소제", "용질 가소제"]),
    ("solvent_etoh", "용매Etoh", "Solvent EtOH", "용매 중 에탄올량", "measurement", "text", "g", "mass",
     ["Etoh", "에탄올", "용매 Etoh"]),
    ("solvent_toluene", "용매Toluene", "Solvent Toluene", "용매 중 톨루엔량", "measurement", "text", "g", "mass",
     ["Toluene", "톨루엔", "용매 Toluene"]),
    ("sol_amount", "Sol양", "Sol Amount", "Sol 총량", "measurement", "text", "g", "mass",
     ["Sol 양", "Sol양", "Sol Amount"]),

    # Checksheet 투입량
    ("input_weight", "투입무게", "Input Weight", "투입 무게 (g)", "measurement", "text", "g", "mass",
     ["투입 무게", "투입무게", "Input Weight"]),

    # 메모
    ("memo", "메모", "Memo", "작업 메모/조건", "identifier", "text", None, None,
     ["메모", "Memo", "작업조건"]),
]

# Build concepts list
concepts = []
for cat in l1_categories:
    concepts.append({
        "concept_id": cat[0],
        "canonical_name": cat[1],
        "canonical_name_en": cat[2],
        "description": cat[3],
        "concept_type": "category",
        "data_type": None,
        "domain_level": "L1",
        "canonical_unit": None,
        "unit_dimension": None,
        "status": "ACTIVE",
        "aliases": [],
    })

for c in l2_concepts:
    concepts.append({
        "concept_id": c[0],
        "canonical_name": c[1],
        "canonical_name_en": c[2],
        "description": c[3],
        "concept_type": c[4],
        "data_type": c[5],
        "domain_level": "L2",
        "canonical_unit": c[6],
        "unit_dimension": c[7],
        "status": "ACTIVE",
        "aliases": c[8],
    })

# Build relations
relations = [
    # Process flow
    ["domain_experiment", "domain_summary", "AFFECTS"],
    ["domain_summary", "domain_weighing", "PART_OF"],
    ["domain_weighing", "domain_apex", "PART_OF"],
    ["domain_apex", "domain_apex_filter", "PART_OF"],
    ["domain_apex_filter", "domain_final_filter", "PART_OF"],
    ["domain_final_filter", "domain_batch_inspection", "PART_OF"],
    ["domain_batch_inspection", "domain_stirring", "RELATED_TO"],
    ["domain_calculation", "domain_input", "AFFECTS"],
    # L2 -> L1 membership
    ["title", "domain_experiment", "IS_A"],
    ["material_code", "domain_experiment", "IS_A"],
    ["input_date", "domain_experiment", "IS_A"],
    ["author", "domain_experiment", "IS_A"],
    ["lot_no", "domain_summary", "IS_A"],
    ["powder", "domain_summary", "IS_A"],
    ["binder_composition", "domain_summary", "IS_A"],
    ["additive", "domain_summary", "IS_A"],
    ["sr_ratio", "domain_summary", "IS_A"],
    ["binder", "domain_summary", "IS_A"],
    ["dispersant", "domain_summary", "IS_A"],
    ["solid_content", "domain_summary", "IS_A"],
    ["solvent", "domain_summary", "IS_A"],
    ["input_product", "domain_weighing", "IS_A"],
    ["weight_target", "domain_weighing", "IS_A"],
    ["tolerance", "domain_weighing", "IS_A"],
    ["material_name", "domain_apex", "IS_A"],
    ["input_amount", "domain_apex", "IS_A"],
    ["slurry_temperature", "domain_apex", "IS_A"],
    ["rotor_rpm", "domain_apex", "IS_A"],
    ["flow_rate", "domain_apex", "IS_A"],
    ["cylinder_pressure", "domain_apex_filter", "IS_A"],
    ["pass_time", "domain_apex_filter", "IS_A"],
    ["oil_temperature", "domain_apex_filter", "IS_A"],
    ["viscosity", "domain_batch_inspection", "IS_A"],
    ["specific_gravity", "domain_batch_inspection", "IS_A"],
    ["solid_content_pct", "domain_batch_inspection", "IS_A"],
    ["crushing_bet", "domain_batch_inspection", "IS_A"],
    ["final_bet", "domain_batch_inspection", "IS_A"],
    ["sub_process", "domain_stirring", "IS_A"],
    ["stirring_rpm", "domain_stirring", "IS_A"],
    ["calc_item", "domain_calculation", "IS_A"],
    ["input_weight", "domain_input", "IS_A"],
    # Cross-domain causal
    ["additive", "viscosity", "AFFECTS"],
    ["additive", "specific_gravity", "AFFECTS"],
    ["additive", "solid_content_pct", "AFFECTS"],
    ["additive", "crushing_bet", "AFFECTS"],
    ["additive", "final_bet", "AFFECTS"],
    ["binder", "viscosity", "AFFECTS"],
    ["dispersant", "viscosity", "AFFECTS"],
    ["solid_content", "viscosity", "AFFECTS"],
    ["rotor_rpm", "crushing_bet", "AFFECTS"],
    ["slurry_temperature", "viscosity", "AFFECTS"],
]

domain_kg = {
    "version": "1",
    "domain": "mlcc_additive",
    "description": "MLCC 첨가제 체크시트 도메인의 고정 지식 그래프 (Fixed Domain KG v1.0) — checksheet_tree.txt 기반",
    "concepts": concepts,
    "relations": relations,
}

out = Path("domains/mlcc_additive/config/domain_kg.yaml")
out.parent.mkdir(parents=True, exist_ok=True)
with open(out, "w", encoding="utf-8") as f:
    yaml.dump(domain_kg, f, allow_unicode=True, default_flow_style=False, sort_keys=False)

print(f"Written {len(concepts)} concepts, {len(relations)} relations to {out}")
