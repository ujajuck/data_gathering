#!/usr/bin/env python
"""CSV Header → Document KG + Domain KG 빌더

각 CSV의 헤더를 Document KG로 변환하고, 유사 개념을 묶어
통합 Domain KG를 생성한다.

Usage:
    python scripts/csv_dkg_builder.py --ws domains/mlcc_additive --fetch
"""
from __future__ import annotations
import argparse, csv, json, re, sys
from collections import defaultdict
from io import StringIO
from pathlib import Path

import urllib.request
import yaml

# ── CSV 소스 정의 ──────────────────────────────────────────────
CSV_BASE = "http://166.79.21.126:8600/raw"
CSV_FILES = {
    "checksheet_table": {
        "url": f"{CSV_BASE}/checksheet_table.csv",
        "file_col": "파일명",
        "description": "첨가제 CHECKSHEET — 제조 공정 기록",
        "l1_prefix": "cs",
    },
    "data_table": {
        "url": f"{CSV_BASE}/data_table.csv",
        "file_col": "_source_file",
        "description": "조성평가 Data 시트 — 소성/전기특성",
        "l1_prefix": "data",
    },
    "dc_db_table": {
        "url": f"{CSV_BASE}/dc_db_table.csv",
        "file_col": "_source_file",
        "description": "조성평가 DC DB — DC 특성 요약",
        "l1_prefix": "dc_db",
    },
    "dc_table": {
        "url": f"{CSV_BASE}/dc_table.csv",
        "file_col": "_source_file",
        "description": "조성평가 DC — DC 특성 상세",
        "l1_prefix": "dc",
    },
    "joined_data_dc": {
        "url": f"{CSV_BASE}/joined_data_dc.csv",
        "file_col": "_source_file",
        "description": "조성평가 Data+DC 통합 — 전기+DC 특성",
        "l1_prefix": "joined",
    },
}

# ── L1 카테고리 정의 (CSV별 헤더 그룹핑) ──────────────────────
HEADER_CATEGORIES = {
    "checksheet_table": {
        "cs_experiment": {
            "name": "실험기본정보", "name_en": "Experiment Info",
            "headers": ["파일명", "제목", "자료코드", "투입일", "작성자", "LOT"],
        },
        "cs_additive": {
            "name": "첨가제구성", "name_en": "Additive Composition",
            "headers": ["Additive", "Powder", "Binder조성", "Binder", "S/R비", "분산제", "고형분", "솔벤트"],
        },
        "cs_weighing": {
            "name": "칭량투입량", "name_en": "Weighing Input",
            "headers": ["Etoh [g]", "BYK103 [g]", "BL-1 [g]", "파우더 [g]",
                        "1차 바인더 [g]", "2차 바인더 [g]", "가소제 [g]",
                        "칭량_1", "칭량_2", "칭량_3", "칭량_4"],
        },
        "cs_property": {
            "name": "물성측정값", "name_en": "Property Measurement",
            "headers": ["비 중(g/cc) (참고치)", "고형분(%) (참고치)",
                        "해쇄BET (가소BET, 참고치)", "최종BET (가소BET, 참고치)",
                        "점 도(cP s) (참고치)"],
        },
        "cs_apex": {
            "name": "APEX공정", "name_en": "APEX Process",
            "headers": ["APEX투입_1", "APEX투입_2", "APEX_Tank Type",
                        "APEX_Slurry온도", "APEX_냉각수온도", "APEX_Rotor RPM", "APEX_유량"],
        },
        "cs_mfd": {
            "name": "MFD공정", "name_en": "MFD Process",
            "headers": ["MFD_1pass 소요시간", "MFD_슬러리온도", "MFD_실린더압력",
                        "MFD_유량", "MFD_오일온도"],
        },
    },
    "data_table": {
        "data_experiment": {
            "name": "실험식별정보", "name_en": "Experiment Identity",
            "headers": ["_source_file", "차수", "구분", "모재/조성", "기종", "lot"],
        },
        "data_firing": {
            "name": "소성조건", "name_en": "Firing Conditions",
            "headers": ["소성Profile", "소성조건-2차가소", "소성조건-1차소성",
                        "소성조건-본소성수소+keep", "소성조건-재산화+소성일자"],
        },
        "data_electrical": {
            "name": "전기특성", "name_en": "Electrical Properties",
            "headers": ["Cp", "DF", "BDV AVG", "BDV MIN", "Cp STDEV", "DF STDEV",
                        "BDV STDEV", "Short", "일반조건", "특수조건",
                        "Cp/Df AVG", "Cp/Df MIN", "Cp/Df MAX"],
        },
    },
    "dc_db_table": {
        "dc_db_experiment": {
            "name": "DC실험식별", "name_en": "DC Experiment Identity",
            "headers": ["_source_file", "exp_id", "조성", "최종몰비"],
        },
        "dc_db_structure": {
            "name": "적층구조", "name_en": "Layer Structure",
            "headers": ["S/T", "L/D", "Layer", "1차소성"],
        },
        "dc_db_firing": {
            "name": "소성조건", "name_en": "Firing Conditions",
            "headers": ["수소농도", "keep", "소성온도"],
        },
        "dc_db_measurement": {
            "name": "DC측정", "name_en": "DC Measurement",
            "headers": ["측정조건", "유지시간", "DC전압", "Cp", "DF", "ΔCp%"],
        },
    },
    "dc_table": {
        "dc_experiment": {
            "name": "DC실험식별", "name_en": "DC Experiment Identity",
            "headers": ["_source_file", "exp_id", "조성", "최종몰비"],
        },
        "dc_structure": {
            "name": "적층구조", "name_en": "Layer Structure",
            "headers": ["S/T", "L/D", "Layer", "1차소성"],
        },
        "dc_firing": {
            "name": "소성조건", "name_en": "Firing Conditions",
            "headers": ["수소농도", "keep", "소성온도"],
        },
        "dc_measurement": {
            "name": "DC측정", "name_en": "DC Measurement",
            "headers": ["측정조건", "DC전압", "유지시간", "Cp", "DF", "Cp변화율"],
        },
    },
    "joined_data_dc": {
        "joined_experiment": {
            "name": "통합실험식별", "name_en": "Joined Experiment Identity",
            "headers": ["_source_file", "exp_id", "구분", "모재/조성", "기종", "lot"],
        },
        "joined_firing": {
            "name": "소성조건", "name_en": "Firing Conditions",
            "headers": ["소성Profile", "소성조건-2차가소", "소성조건-1차소성",
                        "소성조건-본소성수소+keep", "소성조건-재산화+소성일자"],
        },
        "joined_electrical": {
            "name": "전기특성", "name_en": "Electrical Properties",
            "headers": ["Cp", "DF", "BDV AVG", "BDV MIN", "Cp STDEV", "DF STDEV",
                        "BDV STDEV", "Short", "일반조건", "특수조건",
                        "Cp/Df AVG", "Cp/Df MIN", "Cp/Df MAX"],
        },
        "joined_dc": {
            "name": "DC특성", "name_en": "DC Properties",
            "headers": ["DC_조성", "최종몰비", "S/T", "L/D", "Layer", "1차소성",
                        "수소농도", "keep", "소성온도", "측정조건", "유지시간",
                        "DC전압", "DC_Cp", "DC_DF", "ΔCp%", "_match"],
        },
    },
}

# ── 통합 Domain KG: 유사 개념 병합 ────────────────────────────
UNIFIED_L1 = {
    "experiment_info": {"name": "실험식별정보", "name_en": "Experiment Identity",
        "desc": "실험의 기본 식별 정보 (파일, 차수, 기종, LOT 등)"},
    "additive_composition": {"name": "첨가제구성", "name_en": "Additive Composition",
        "desc": "첨가제의 구성 성분 (Additive, Powder, Binder 등)"},
    "weighing_input": {"name": "칭량투입량", "name_en": "Weighing Input",
        "desc": "칭량 및 투입량 (용매, 바인더, 파우더 등)"},
    "property_measurement": {"name": "물성측정값", "name_en": "Property Measurement",
        "desc": "슬러리/분말 물성 측정값 (비중, 고형분, BET, 점도)"},
    "apex_process": {"name": "APEX공정", "name_en": "APEX Process",
        "desc": "APEX 해쇄/분산 공정 조건"},
    "mfd_process": {"name": "MFD공정", "name_en": "MFD Process",
        "desc": "MFD 분산 공정 조건"},
    "firing_condition": {"name": "소성조건", "name_en": "Firing Conditions",
        "desc": "소성 공정 조건 (프로파일, 온도, 수소농도 등)"},
    "electrical_property": {"name": "전기특성", "name_en": "Electrical Properties",
        "desc": "정전용량, 손실, 내전압 등 전기 특성"},
    "dc_property": {"name": "DC특성", "name_en": "DC Properties",
        "desc": "DC 특성 (DC 전압, Cp, DF, ΔCp%)"},
    "layer_structure": {"name": "적층구조", "name_en": "Layer Structure",
        "desc": "적층 구조 파라미터 (S/T, L/D, Layer)"},
    "composition_info": {"name": "조성정보", "name_en": "Composition Info",
        "desc": "조성 관련 정보 (조성, 최종몰비)"},
}

# ── CSV 헤더 → 통합 concept_id 매핑 ────────────────────────────
HEADER_TO_CONCEPT = {
    # 실험식별
    "파일명": "source_file", "_source_file": "source_file",
    "제목": "title", "자료코드": "data_code", "투입일": "input_date", "작성자": "author",
    "LOT": "lot", "lot": "lot",
    "차수": "batch_no", "구분": "category", "모재/조성": "base_composition", "기종": "model",
    "exp_id": "exp_id",
    # 첨가제구성
    "Additive": "additive", "Powder": "powder",
    "Binder조성": "binder_composition", "Binder": "binder",
    "S/R비": "sr_ratio", "분산제": "dispersant", "고형분": "solid_content", "솔벤트": "solvent",
    # 칭량투입
    "Etoh [g]": "etoh_g", "BYK103 [g]": "byk103_g", "BL-1 [g]": "bl1_g",
    "파우더 [g]": "powder_g", "1차 바인더 [g]": "binder1_g", "2차 바인더 [g]": "binder2_g",
    "가소제 [g]": "plasticizer_g",
    "칭량_1": "weighing_1", "칭량_2": "weighing_2", "칭량_3": "weighing_3", "칭량_4": "weighing_4",
    # 물성측정
    "비 중(g/cc) (참고치)": "specific_gravity", "고형분(%) (참고치)": "solid_content_pct",
    "해쇄BET (가소BET, 참고치)": "crushing_bet", "최종BET (가소BET, 참고치)": "final_bet",
    "점 도(cP s) (참고치)": "viscosity",
    # APEX
    "APEX투입_1": "apex_input_1", "APEX투입_2": "apex_input_2",
    "APEX_Tank Type": "apex_tank_type", "APEX_Slurry온도": "apex_slurry_temp",
    "APEX_냉각수온도": "apex_coolant_temp", "APEX_Rotor RPM": "apex_rpm", "APEX_유량": "apex_flow_rate",
    # MFD
    "MFD_1pass 소요시간": "mfd_1pass_time", "MFD_슬러리온도": "mfd_slurry_temp",
    "MFD_실린더압력": "mfd_cylinder_pressure", "MFD_유량": "mfd_flow_rate", "MFD_오일온도": "mfd_oil_temp",
    # 소성조건
    "소성Profile": "firing_profile", "소성조건-2차가소": "firing_2nd_calcination",
    "소성조건-1차소성": "firing_1st", "소성조건-본소성수소+keep": "firing_hydrogen_keep",
    "소성조건-재산화+소성일자": "firing_reoxidation",
    "수소농도": "hydrogen_concentration", "keep": "keep_condition", "소성온도": "firing_temperature",
    "1차소성": "1st_calcination",
    # 전기특성
    "Cp": "cp", "DF": "df", "BDV AVG": "bdv_avg", "BDV MIN": "bdv_min",
    "Cp STDEV": "cp_stdev", "DF STDEV": "df_stdev", "BDV STDEV": "bdv_stdev",
    "Short": "short_rate", "일반조건": "normal_condition", "특수조건": "special_condition",
    "Cp/Df AVG": "cp_df_avg", "Cp/Df MIN": "cp_df_min", "Cp/Df MAX": "cp_df_max",
    # DC특성
    "DC전압": "dc_voltage", "DC_Cp": "dc_cp", "DC_DF": "dc_df",
    "ΔCp%": "delta_cp_pct", "Cp변화율": "cp_change_rate",
    "측정조건": "measurement_condition", "유지시간": "hold_time",
    # 적층구조
    "S/T": "s_t_ratio", "L/D": "l_d_ratio", "Layer": "layer_count",
    # 조성
    "조성": "composition", "최종몰비": "final_mole_ratio", "DC_조성": "dc_composition",
    # 메타
    "_match": "match_type",
}

# ── L2 concept 상세 정의 ───────────────────────────────────────
L2_CONCEPTS = {
    # 실험식별
    "source_file": {"name": "원본파일", "en": "Source File", "dtype": "text", "unit": None,
                    "desc": "원본 실험 데이터 파일명", "parent": "experiment_info",
                    "aliases": ["파일명", "_source_file"]},
    "exp_id": {"name": "실험ID", "en": "Experiment ID", "dtype": "text", "unit": None,
               "desc": "실험 차수 ID", "parent": "experiment_info", "aliases": []},
    "batch_no": {"name": "차수", "en": "Batch Number", "dtype": "text", "unit": None,
                 "desc": "실험 차수", "parent": "experiment_info", "aliases": []},
    "category": {"name": "구분", "en": "Category", "dtype": "text", "unit": None,
                 "desc": "실험 구분 (연검 등)", "parent": "experiment_info", "aliases": []},
    "base_composition": {"name": "모재/조성", "en": "Base/Composition", "dtype": "text", "unit": None,
                         "desc": "모재 또는 조성명", "parent": "experiment_info",
                         "aliases": ["모재/조성"]},
    "model": {"name": "기종", "en": "Model", "dtype": "text", "unit": None,
              "desc": "제품 기종 코드", "parent": "experiment_info", "aliases": []},
    "lot": {"name": "LOT", "en": "LOT", "dtype": "text", "unit": None,
            "desc": "LOT 번호", "parent": "experiment_info", "aliases": []},
    "title": {"name": "제목", "en": "Title", "dtype": "text", "unit": None,
              "desc": "실험 제목", "parent": "experiment_info", "aliases": []},
    "data_code": {"name": "자료코드", "en": "Data Code", "dtype": "text", "unit": None,
                  "desc": "자료 관리 코드", "parent": "experiment_info", "aliases": []},
    "input_date": {"name": "투입일", "en": "Input Date", "dtype": "date", "unit": None,
                   "desc": "실험 투입 일자", "parent": "experiment_info", "aliases": []},
    "author": {"name": "작성자", "en": "Author", "dtype": "text", "unit": None,
               "desc": "실험 작성자", "parent": "experiment_info", "aliases": []},
    # 첨가제
    "additive": {"name": "Additive", "en": "Additive", "dtype": "text", "unit": None,
                 "desc": "첨가제 코드", "parent": "additive_composition", "aliases": []},
    "powder": {"name": "Powder", "en": "Powder", "dtype": "text", "unit": None,
               "desc": "파우더 종류", "parent": "additive_composition", "aliases": []},
    "binder_composition": {"name": "Binder조성", "en": "Binder Composition", "dtype": "text", "unit": None,
                           "desc": "바인더 조성", "parent": "additive_composition",
                           "aliases": ["Binder조성"]},
    "binder": {"name": "Binder", "en": "Binder", "dtype": "text", "unit": None,
               "desc": "바인더 종류", "parent": "additive_composition", "aliases": []},
    "sr_ratio": {"name": "S/R비", "en": "S/R Ratio", "dtype": "number", "unit": None,
                 "desc": "Solid/Resin 비", "parent": "additive_composition", "aliases": []},
    "dispersant": {"name": "분산제", "en": "Dispersant", "dtype": "text", "unit": None,
                   "desc": "분산제 종류", "parent": "additive_composition", "aliases": []},
    "solid_content": {"name": "고형분", "en": "Solid Content", "dtype": "text", "unit": None,
                      "desc": "고형분 비율", "parent": "additive_composition", "aliases": []},
    "solvent": {"name": "솔벤트", "en": "Solvent", "dtype": "text", "unit": None,
                "desc": "용매 종류", "parent": "additive_composition", "aliases": []},
    # 칭량
    "etoh_g": {"name": "Etoh [g]", "en": "Ethanol", "dtype": "number", "unit": "g",
               "desc": "에탄올 투입량", "parent": "weighing_input", "aliases": []},
    "byk103_g": {"name": "BYK103 [g]", "en": "BYK103", "dtype": "number", "unit": "g",
                 "desc": "BYK103 분산제 투입량", "parent": "weighing_input", "aliases": []},
    "bl1_g": {"name": "BL-1 [g]", "en": "BL-1", "dtype": "number", "unit": "g",
              "desc": "BL-1 투입량", "parent": "weighing_input", "aliases": []},
    "powder_g": {"name": "파우더 [g]", "en": "Powder Weight", "dtype": "number", "unit": "g",
                 "desc": "파우더 투입량", "parent": "weighing_input", "aliases": []},
    "binder1_g": {"name": "1차 바인더 [g]", "en": "1st Binder", "dtype": "number", "unit": "g",
                  "desc": "1차 바인더 투입량", "parent": "weighing_input", "aliases": []},
    "binder2_g": {"name": "2차 바인더 [g]", "en": "2nd Binder", "dtype": "number", "unit": "g",
                  "desc": "2차 바인더 투입량", "parent": "weighing_input", "aliases": []},
    "plasticizer_g": {"name": "가소제 [g]", "en": "Plasticizer", "dtype": "number", "unit": "g",
                      "desc": "가소제 투입량", "parent": "weighing_input", "aliases": []},
    "weighing_1": {"name": "칭량_1", "en": "Weighing 1", "dtype": "text", "unit": None,
                   "desc": "칭량 정보 1", "parent": "weighing_input", "aliases": []},
    "weighing_2": {"name": "칭량_2", "en": "Weighing 2", "dtype": "text", "unit": None,
                   "desc": "칭량 정보 2", "parent": "weighing_input", "aliases": []},
    "weighing_3": {"name": "칭량_3", "en": "Weighing 3", "dtype": "text", "unit": None,
                   "desc": "칭량 정보 3", "parent": "weighing_input", "aliases": []},
    "weighing_4": {"name": "칭량_4", "en": "Weighing 4", "dtype": "text", "unit": None,
                   "desc": "칭량 정보 4", "parent": "weighing_input", "aliases": []},
    # 물성
    "specific_gravity": {"name": "비중", "en": "Specific Gravity", "dtype": "number", "unit": "g/cc",
                         "desc": "슬러리 비중", "parent": "property_measurement",
                         "aliases": ["비 중(g/cc) (참고치)"]},
    "solid_content_pct": {"name": "고형분(%)", "en": "Solid Content %", "dtype": "number", "unit": "%",
                          "desc": "슬러리 고형분율", "parent": "property_measurement",
                          "aliases": ["고형분(%) (참고치)"]},
    "crushing_bet": {"name": "해쇄BET", "en": "Crushing BET", "dtype": "number", "unit": "㎡/g",
                     "desc": "해쇄 후 BET 비표면적", "parent": "property_measurement",
                     "aliases": ["해쇄BET (가소BET, 참고치)"]},
    "final_bet": {"name": "최종BET", "en": "Final BET", "dtype": "number", "unit": "㎡/g",
                  "desc": "최종 BET 비표면적", "parent": "property_measurement",
                  "aliases": ["최종BET (가소BET, 참고치)"]},
    "viscosity": {"name": "점도", "en": "Viscosity", "dtype": "number", "unit": "cP·s",
                  "desc": "슬러리 점도", "parent": "property_measurement",
                  "aliases": ["점 도(cP s) (참고치)"]},
    # APEX
    "apex_input_1": {"name": "APEX투입_1", "en": "APEX Input 1", "dtype": "text", "unit": None,
                     "desc": "APEX 1차 투입 정보", "parent": "apex_process", "aliases": []},
    "apex_input_2": {"name": "APEX투입_2", "en": "APEX Input 2", "dtype": "text", "unit": None,
                     "desc": "APEX 2차 투입 정보", "parent": "apex_process", "aliases": []},
    "apex_tank_type": {"name": "APEX Tank Type", "en": "APEX Tank Type", "dtype": "text", "unit": None,
                       "desc": "APEX 탱크 타입", "parent": "apex_process", "aliases": []},
    "apex_slurry_temp": {"name": "APEX 슬러리온도", "en": "APEX Slurry Temp", "dtype": "number", "unit": "℃",
                         "desc": "APEX 슬러리 온도", "parent": "apex_process", "aliases": []},
    "apex_coolant_temp": {"name": "APEX 냉각수온도", "en": "APEX Coolant Temp", "dtype": "number", "unit": "℃",
                          "desc": "APEX 냉각수 온도", "parent": "apex_process", "aliases": []},
    "apex_rpm": {"name": "APEX RPM", "en": "APEX Rotor RPM", "dtype": "number", "unit": "rpm",
                 "desc": "APEX 로터 회전수", "parent": "apex_process", "aliases": []},
    "apex_flow_rate": {"name": "APEX 유량", "en": "APEX Flow Rate", "dtype": "number", "unit": "s/250cc",
                       "desc": "APEX 유량", "parent": "apex_process", "aliases": []},
    # MFD
    "mfd_1pass_time": {"name": "MFD 1pass 소요시간", "en": "MFD 1-pass Time", "dtype": "text", "unit": None,
                       "desc": "MFD 1패스 소요 시간", "parent": "mfd_process", "aliases": []},
    "mfd_slurry_temp": {"name": "MFD 슬러리온도", "en": "MFD Slurry Temp", "dtype": "number", "unit": "℃",
                        "desc": "MFD 슬러리 온도", "parent": "mfd_process", "aliases": []},
    "mfd_cylinder_pressure": {"name": "MFD 실린더압력", "en": "MFD Cylinder Pressure", "dtype": "number", "unit": "psi",
                              "desc": "MFD 실린더 압력", "parent": "mfd_process", "aliases": []},
    "mfd_flow_rate": {"name": "MFD 유량", "en": "MFD Flow Rate", "dtype": "text", "unit": None,
                      "desc": "MFD 유량", "parent": "mfd_process", "aliases": []},
    "mfd_oil_temp": {"name": "MFD 오일온도", "en": "MFD Oil Temp", "dtype": "number", "unit": "℃",
                     "desc": "MFD 오일 온도", "parent": "mfd_process", "aliases": []},
    # 소성
    "firing_profile": {"name": "소성Profile", "en": "Firing Profile", "dtype": "text", "unit": None,
                       "desc": "소성 프로파일 코드", "parent": "firing_condition", "aliases": []},
    "firing_2nd_calcination": {"name": "2차가소조건", "en": "2nd Calcination", "dtype": "text", "unit": None,
                               "desc": "2차 가소 소성 조건", "parent": "firing_condition", "aliases": []},
    "firing_1st": {"name": "1차소성조건", "en": "1st Firing", "dtype": "text", "unit": None,
                   "desc": "1차 소성 조건", "parent": "firing_condition", "aliases": []},
    "firing_hydrogen_keep": {"name": "본소성수소+keep", "en": "Hydrogen+Keep", "dtype": "text", "unit": None,
                             "desc": "본소성 수소 농도 + keep", "parent": "firing_condition", "aliases": []},
    "firing_reoxidation": {"name": "재산화+소성일자", "en": "Reoxidation+Date", "dtype": "text", "unit": None,
                           "desc": "재산화 + 소성 일자", "parent": "firing_condition", "aliases": []},
    "hydrogen_concentration": {"name": "수소농도", "en": "Hydrogen Concentration", "dtype": "text", "unit": None,
                               "desc": "소성 수소 농도", "parent": "firing_condition", "aliases": []},
    "keep_condition": {"name": "keep", "en": "Keep", "dtype": "text", "unit": None,
                       "desc": "소성 keep 조건", "parent": "firing_condition", "aliases": []},
    "firing_temperature": {"name": "소성온도", "en": "Firing Temperature", "dtype": "number", "unit": "℃",
                           "desc": "소성 온도", "parent": "firing_condition", "aliases": []},
    "1st_calcination": {"name": "1차소성", "en": "1st Calcination", "dtype": "text", "unit": None,
                        "desc": "1차 소성 정보", "parent": "firing_condition", "aliases": []},
    # 전기특성
    "cp": {"name": "Cp", "en": "Capacitance", "dtype": "number", "unit": "pF",
           "desc": "정전용량", "parent": "electrical_property", "aliases": []},
    "df": {"name": "DF", "en": "Dissipation Factor", "dtype": "number", "unit": "%",
           "desc": "유전손실", "parent": "electrical_property", "aliases": []},
    "bdv_avg": {"name": "BDV AVG", "en": "BDV Average", "dtype": "number", "unit": "V",
                "desc": "내전압 평균", "parent": "electrical_property", "aliases": []},
    "bdv_min": {"name": "BDV MIN", "en": "BDV Minimum", "dtype": "number", "unit": "V",
                "desc": "내전압 최소", "parent": "electrical_property", "aliases": []},
    "cp_stdev": {"name": "Cp STDEV", "en": "Cp Std Dev", "dtype": "number", "unit": "pF",
                 "desc": "정전용량 표준편차", "parent": "electrical_property", "aliases": []},
    "df_stdev": {"name": "DF STDEV", "en": "DF Std Dev", "dtype": "number", "unit": "%",
                 "desc": "유전손실 표준편차", "parent": "electrical_property", "aliases": []},
    "bdv_stdev": {"name": "BDV STDEV", "en": "BDV Std Dev", "dtype": "number", "unit": "V",
                  "desc": "내전압 표준편차", "parent": "electrical_property", "aliases": []},
    "short_rate": {"name": "Short", "en": "Short Rate", "dtype": "number", "unit": None,
                   "desc": "단락 여부/비율", "parent": "electrical_property", "aliases": []},
    "normal_condition": {"name": "일반조건", "en": "Normal Condition", "dtype": "text", "unit": None,
                         "desc": "일반 측정 조건", "parent": "electrical_property", "aliases": []},
    "special_condition": {"name": "특수조건", "en": "Special Condition", "dtype": "text", "unit": None,
                          "desc": "특수 측정 조건", "parent": "electrical_property", "aliases": []},
    "cp_df_avg": {"name": "Cp/Df AVG", "en": "Cp/DF Average", "dtype": "number", "unit": None,
                  "desc": "Cp/DF 비 평균", "parent": "electrical_property", "aliases": []},
    "cp_df_min": {"name": "Cp/Df MIN", "en": "Cp/DF Minimum", "dtype": "number", "unit": None,
                  "desc": "Cp/DF 비 최소", "parent": "electrical_property", "aliases": []},
    "cp_df_max": {"name": "Cp/Df MAX", "en": "Cp/DF Maximum", "dtype": "number", "unit": None,
                  "desc": "Cp/DF 비 최대", "parent": "electrical_property", "aliases": []},
    # DC
    "dc_voltage": {"name": "DC전압", "en": "DC Voltage", "dtype": "number", "unit": "V",
                   "desc": "DC 인가 전압", "parent": "dc_property", "aliases": []},
    "dc_cp": {"name": "DC_Cp", "en": "DC Capacitance", "dtype": "number", "unit": "pF",
              "desc": "DC 측정 정전용량", "parent": "dc_property", "aliases": []},
    "dc_df": {"name": "DC_DF", "en": "DC Dissipation Factor", "dtype": "number", "unit": "%",
              "desc": "DC 측정 유전손실", "parent": "dc_property", "aliases": []},
    "delta_cp_pct": {"name": "ΔCp%", "en": "Delta Cp %", "dtype": "number", "unit": "%",
                     "desc": "Cp 변화율 (%)", "parent": "dc_property", "aliases": []},
    "cp_change_rate": {"name": "Cp변화율", "en": "Cp Change Rate", "dtype": "number", "unit": "%",
                       "desc": "Cp 변화율", "parent": "dc_property", "aliases": []},
    "measurement_condition": {"name": "측정조건", "en": "Measurement Condition", "dtype": "text", "unit": None,
                              "desc": "측정 조건 (주파수, 전압 등)", "parent": "dc_property", "aliases": []},
    "hold_time": {"name": "유지시간", "en": "Hold Time", "dtype": "number", "unit": "s",
                  "desc": "DC 전압 유지 시간", "parent": "dc_property", "aliases": []},
    # 적층
    "s_t_ratio": {"name": "S/T", "en": "S/T Ratio", "dtype": "number", "unit": None,
                  "desc": "Screen/Thickness 비", "parent": "layer_structure", "aliases": []},
    "l_d_ratio": {"name": "L/D", "en": "L/D Ratio", "dtype": "number", "unit": None,
                  "desc": "Length/Diameter 비", "parent": "layer_structure", "aliases": []},
    "layer_count": {"name": "Layer", "en": "Layer Count", "dtype": "number", "unit": None,
                    "desc": "적층 수", "parent": "layer_structure", "aliases": []},
    # 조성
    "composition": {"name": "조성", "en": "Composition", "dtype": "text", "unit": None,
                    "desc": "조성명", "parent": "composition_info", "aliases": []},
    "final_mole_ratio": {"name": "최종몰비", "en": "Final Mole Ratio", "dtype": "text", "unit": None,
                         "desc": "최종 몰비", "parent": "composition_info", "aliases": []},
    "dc_composition": {"name": "DC_조성", "en": "DC Composition", "dtype": "text", "unit": None,
                       "desc": "DC 측정용 조성", "parent": "composition_info", "aliases": []},
    # 메타
    "match_type": {"name": "_match", "en": "Match Type", "dtype": "text", "unit": None,
                   "desc": "조인 매치 타입", "parent": "experiment_info", "aliases": []},
}


def fetch_csv(url: str) -> list[dict]:
    data = urllib.request.urlopen(url).read()
    text = data.decode("utf-8-sig")
    return list(csv.DictReader(StringIO(text)))


def build_document_kg(csv_name: str, csv_info: dict, rows: list[dict]) -> dict:
    categories = HEADER_CATEGORIES.get(csv_name, {})
    headers = list(rows[0].keys()) if rows else []
    doc_kg = {"csv_name": csv_name, "description": csv_info["description"],
              "row_count": len(rows), "categories": {}}
    for cat_id, cat_info in categories.items():
        present = [h for h in cat_info["headers"] if h in headers]
        doc_kg["categories"][cat_id] = {
            "name": cat_info["name"], "name_en": cat_info["name_en"],
            "headers": present,
            "concepts": [HEADER_TO_CONCEPT.get(h, h) for h in present],
        }
    return doc_kg


def build_unified_domain_kg() -> dict:
    concepts = []
    relations = []
    # L1
    for cid, info in UNIFIED_L1.items():
        concepts.append({
            "concept_id": cid, "canonical_name": info["name"],
            "canonical_name_en": info["name_en"], "description": info["desc"],
            "concept_type": "category", "data_type": None,
            "domain_level": "L1", "canonical_unit": None,
            "unit_dimension": None, "status": "ACTIVE", "aliases": [],
        })
    # L2
    for cid, info in L2_CONCEPTS.items():
        concepts.append({
            "concept_id": cid, "canonical_name": info["name"],
            "canonical_name_en": info["en"], "description": info["desc"],
            "concept_type": "property", "data_type": info["dtype"],
            "domain_level": "L2", "canonical_unit": info["unit"],
            "unit_dimension": None, "status": "ACTIVE", "aliases": info.get("aliases", []),
        })
        relations.append([cid, info["parent"], "PART_OF"])
    # Cross-L1 relations
    cross = [
        ["additive_composition", "property_measurement", "AFFECTS"],
        ["weighing_input", "property_measurement", "AFFECTS"],
        ["apex_process", "property_measurement", "AFFECTS"],
        ["mfd_process", "property_measurement", "AFFECTS"],
        ["firing_condition", "electrical_property", "AFFECTS"],
        ["firing_condition", "dc_property", "AFFECTS"],
        ["layer_structure", "electrical_property", "AFFECTS"],
        ["composition_info", "electrical_property", "AFFECTS"],
        ["dc_property", "electrical_property", "RELATED_TO"],
        ["composition_info", "additive_composition", "RELATED_TO"],
        ["property_measurement", "electrical_property", "RELATED_TO"],
    ]
    relations.extend(cross)
    return {"version": "2", "domain": "mlcc_composition",
            "description": "MLCC 조성평가 통합 Domain KG — CSV 헤더 기반 자동 생성",
            "concepts": concepts, "relations": relations}


def build_csv_ingest_template(csv_name: str, csv_info: dict) -> dict:
    categories = HEADER_CATEGORIES.get(csv_name, {})
    template = {"csv_name": csv_name, "url": csv_info["url"],
                "file_col": csv_info["file_col"], "l1_prefix": csv_info["l1_prefix"],
                "node_types": {}}
    for cat_id, cat_info in categories.items():
        template["node_types"][cat_id] = {"type": "SECTION", "name": cat_info["name"], "children": {}}
        for h in cat_info["headers"]:
            concept_id = HEADER_TO_CONCEPT.get(h, h)
            template["node_types"][cat_id]["children"][h] = {
                "type": "HEADER", "concept_hint": concept_id, "value_type": "VALUE"}
    return template


def main():
    parser = argparse.ArgumentParser(description="CSV Header → Document KG + Domain KG 빌더")
    parser.add_argument("--ws", type=Path, default=Path("domains/mlcc_additive"))
    parser.add_argument("--output-dir", type=Path, default=None)
    parser.add_argument("--fetch", action="store_true")
    args = parser.parse_args()

    out_dir = args.output_dir or (args.ws / "csv_dkg")
    out_dir.mkdir(parents=True, exist_ok=True)

    # 1. 통합 Domain KG
    unified = build_unified_domain_kg()
    dkg_path = out_dir / "domain_kg_unified.yaml"
    dkg_path.write_text(yaml.dump(unified, allow_unicode=True, default_flow_style=False, sort_keys=False),
                        encoding="utf-8")
    l1 = sum(1 for c in unified["concepts"] if c["domain_level"] == "L1")
    l2 = sum(1 for c in unified["concepts"] if c["domain_level"] == "L2")
    print(f"✅ 통합 Domain KG: {l1} L1 + {l2} L2 concepts, {len(unified['relations'])} relations")
    print(f"   → {dkg_path}")

    # 2. CSV별 Document KG + 템플릿
    all_doc_kgs = {}
    for csv_name, csv_info in CSV_FILES.items():
        rows = fetch_csv(csv_info["url"]) if args.fetch else []
        doc_kg = build_document_kg(csv_name, csv_info, rows)
        all_doc_kgs[csv_name] = doc_kg
        template = build_csv_ingest_template(csv_name, csv_info)

        doc_path = out_dir / f"doc_kg_{csv_name}.yaml"
        doc_path.write_text(yaml.dump(doc_kg, allow_unicode=True, default_flow_style=False, sort_keys=False),
                           encoding="utf-8")
        tmpl_path = out_dir / f"ingest_template_{csv_name}.yaml"
        tmpl_path.write_text(yaml.dump(template, allow_unicode=True, default_flow_style=False, sort_keys=False),
                            encoding="utf-8")
        cat_count = len(doc_kg["categories"])
        h_count = sum(len(c["headers"]) for c in doc_kg["categories"].values())
        print(f"  📄 {csv_name}: {cat_count} categories, {h_count} headers, {len(rows)} rows")

    # 3. 요약
    summary = {
        "domain": "mlcc_composition",
        "csv_sources": list(CSV_FILES.keys()),
        "unified_dkg": {"l1_concepts": l1, "l2_concepts": l2, "relations": len(unified["relations"])},
        "document_kgs": {k: {"categories": len(v["categories"]),
                              "headers": sum(len(c["headers"]) for c in v["categories"].values()),
                              "rows": v.get("row_count", 0)} for k, v in all_doc_kgs.items()},
    }
    summary_path = out_dir / "summary.json"
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n📊 요약 → {summary_path}")
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
