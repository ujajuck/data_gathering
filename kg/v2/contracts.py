"""OpenAPI와 실행기가 공유하는 v2 요청 계약. 위치·의미 검증은 spec.py가 수행한다."""

from __future__ import annotations

from typing import Annotated, Any, Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator

Identifier = Annotated[str, Field(min_length=1, max_length=200)]
ValueType = Literal["text", "decimal", "boolean", "date", "datetime"]
ReviewStatus = Literal["proposed", "approved", "rejected"]


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    def payload(self):
        # 생략한 기본값과 명시한 null을 구분하여 기존 불변 명세·해시 의미를 유지한다.
        return self.model_dump(mode="json", by_alias=True, exclude_unset=True)

    @model_validator(mode="before")
    @classmethod
    def nonnull_structures(cls, value):
        # 생략 가능한 명세라도 명시적 null은 실행기에서 객체로 사용할 수 없다.
        if isinstance(value, dict):
            for key in (
                "normalization",
                "value_spec",
                "record_spec",
                "stop",
                "find",
                "relative",
                "range",
            ):
                if key in cls.model_fields and key in value and value[key] is None:
                    raise ValueError(f"{key}는 null 대신 필드를 생략하세요.")
        return value


class JobRequest(Contract):
    request_key: Annotated[
        str,
        Field(
            min_length=1,
            max_length=128,
            description="필수 멱등성 키. 같은 키와 같은 요청은 기존 작업을 반환한다.",
        ),
    ]


class RegisterRequest(JobRequest):
    source_refs: Annotated[
        list[Annotated[str, Field(min_length=1, max_length=2048)]],
        Field(min_length=1, max_length=100),
    ]
    provider: Identifier = "local-xlsx"
    document_id: Identifier | None = None


class ViewportRequest(JobRequest):
    version_id: Identifier
    sheet_id: Identifier
    r1: int = Field(1, ge=1, le=1048576, strict=True)
    c1: int = Field(1, ge=1, le=16384, strict=True)
    rows: int = Field(40, ge=1, le=100, strict=True)
    cols: int = Field(12, ge=1, le=30, strict=True)


class FindSpec(Contract):
    texts: list[str] = Field(min_length=1, max_length=50)
    within: str = "A1:AZ100"
    occurrence: int | None = Field(None, ge=0, strict=True)


class RelativeSpec(Contract):
    row: int = Field(0, strict=True)
    col: int = Field(0, strict=True)
    rows: int = Field(1, ge=1, le=100000, strict=True)
    cols: int = Field(1, ge=1, le=16384, strict=True)


class AreaSpec(Contract):
    sheet_role: Identifier
    range: str | None = Field(
        None, description="range/find/relative 중 정확히 하나. A1 또는 B3:C20."
    )
    find: FindSpec | None = None
    relative: RelativeSpec | None = None


class StopSpec(Contract):
    kind: Literal["explicit_areas", "blank_run"] = "explicit_areas"
    max_items: int = Field(10000, ge=1, le=100000, strict=True)
    count: int | None = Field(None, ge=1, le=100, strict=True)


class SelectionSpec(Contract):
    areas: list[AreaSpec] = Field(min_length=1, max_length=32)
    repeat: Literal["once", "each"] = "once"
    cardinality: Literal["scalar", "list", "matrix"] = "scalar"
    axis: Literal["none", "down", "right", "row_major", "column_major"] = "none"
    element_layout: Literal["each_cell", "one_per_row", "one_per_column"] | None = None
    merge_policy: Literal["anchor_once"] = "anchor_once"
    blank_policy: Literal["preserve"] = "preserve"
    combine: Literal["ordered_union", "concat", "sum"] = "ordered_union"
    separator: str = " "
    stop: StopSpec | None = None


class SelectorSpec(Contract):
    key: SelectionSpec
    value: SelectionSpec
    unit: SelectionSpec | None = None
    context: SelectionSpec | None = None


class NormalizationStep(Contract):
    op: Literal[
        "trim_text",
        "strip_thousands",
        "split_unit_suffix",
        "percent_to_ratio",
        "automatic",
    ]


class NormalizationSpec(Contract):
    operation: Literal["identity", "trim", "affine", "pipeline"] = "identity"
    version: str = "1"
    factor: str = "1"
    offset: str = "0"
    preset_id: str | None = None
    steps: list[NormalizationStep] | None = Field(None, min_length=1, max_length=16)


class ValueSpec(Contract):
    type: ValueType = "text"
    unit: str | None = None
    source_unit: str | None = None
    formula_policy: Literal["cached_only"] = "cached_only"
    normalization: NormalizationSpec | None = None


class RecordSpec(Contract):
    scope: list[str] = Field(min_length=1, max_length=8)
    key: (
        Literal["coordinate", "physical_row", "physical_column"] | dict[str, str | int]
    ) = "coordinate"


class RuleSpec(Contract):
    rule_key: str | None = None
    concept_id: str | None = None
    selector: SelectorSpec
    value_spec: ValueSpec | None = None
    record_spec: RecordSpec | None = None


class SheetRole(Contract):
    cardinality: Literal["one", "many"] = "one"
    description: str | None = None


class TemplateDefinition(Contract):
    kg_revision_id: Identifier
    format: Literal["json"] = "json"
    schema_version: Literal["2.0"] = "2.0"
    sheet_roles: dict[str, SheetRole]
    rules: list[RuleSpec] = Field(min_length=1, max_length=200)


class TemplateRequest(Contract):
    name: Identifier
    template_id: Identifier | None = None
    definition: TemplateDefinition


class ApplicationRequest(Contract):
    version_id: Identifier
    template_version_id: Identifier
    bindings: dict[str, list[Identifier]]
    scope_key: Identifier | None = None
    approved: bool = False


class RevisionRequest(Contract):
    expected_seq: int = Field(ge=0, strict=True)
    effective_spec: RuleSpec
    concept_id: Identifier | None = None
    status: ReviewStatus = "approved"
    reason: str | None = Field(None, max_length=1000)


class RollbackRequest(Contract):
    expected_seq: int = Field(ge=0, strict=True)
    target_revision_id: Identifier
    reason: str = Field(min_length=1, max_length=1000)


class ConceptDefinition(BaseModel):
    # 기존 수동 YAML의 canonical_name/domain_level 등도 import_kg가 해석한다.
    model_config = ConfigDict(extra="allow")
    concept_id: Identifier
    name: str | None = None
    definition: str | None = None
    level: int | str = 1
    value_type: str | None = None
    canonical_unit: str | None = None
    status: Literal["active", "deprecated", "inactive"] = "active"
    aliases: list[str | dict[str, Any]] = Field(default_factory=list)


class RelationEdit(Contract):
    source: Identifier = Field(alias="from")
    target: Identifier = Field(alias="to")
    type: Identifier


class KGRequest(Contract):
    concepts: list[ConceptDefinition] = Field(min_length=1, max_length=10000)
    relations: list[RelationEdit | tuple[Identifier, Identifier, Identifier]] = Field(
        default_factory=list
    )


class ConceptEditRequest(Contract):
    expected_revision_id: Identifier
    name: str | None = Field(None, min_length=1, max_length=200)
    definition: str | None = None
    aliases: list[str] | None = Field(None, max_length=200)
    status: Literal["active", "deprecated"] | None = None
    add_relations: list[RelationEdit] = Field(default_factory=list, max_length=200)
    remove_relations: list[RelationEdit] = Field(default_factory=list, max_length=200)


class SourceSelection(Contract):
    application_id: Identifier
    rule_key: Identifier
    pinned_run_id: Identifier | None = None


class OutputField(Contract):
    field_key: Identifier
    concept_id: Identifier
    output_name: Annotated[str, Field(min_length=1, max_length=100)]
    target_type: ValueType = "text"
    target_unit: str | None = None
    aggregate: Literal["sum", "min", "max", "count"] = "sum"
    measurement_type: ValueType | None = None
    measurement_unit: str | None = None
    sources: list[SourceSelection] = Field(min_length=1, max_length=100)


class IntegrationSpec(Contract):
    kg_revision_id: Identifier
    row_mode: Literal["record_scope", "business_key", "aggregate"] = "record_scope"
    business_key_confirmed: bool = False
    fields: list[OutputField] = Field(min_length=1, max_length=100)


class IntegrationRequest(Contract):
    name: Identifier
    spec: IntegrationSpec
    project_id: Identifier | None = None


class JobResponse(Contract):
    job_id: str
    kind: Literal["register", "viewport", "extract", "build"]
    state: Literal["queued", "running", "succeeded", "failed", "cancelled"]
    completed: int = 0
    total: int | None = None
    created_at: str
    finished_at: str | None = None
    error_code: str | None = None
    error_message: str | None = None
    result: dict[str, Any] | None = Field(
        None, description="작업 종류별 결과. viewport는 권한 유효기간 동안만 반환한다."
    )
