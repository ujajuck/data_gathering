"""API 쓰기 본문 계약(§6). 모든 모델은 extra=forbid이며 위치·의미 검증은 service/profile이 수행한다."""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

Identifier = Annotated[str, Field(min_length=1, max_length=200)]
Key = Annotated[str, Field(min_length=1, max_length=128)]
ReviewStatus = Literal["proposed", "approved", "rejected"]
RegionRole = Literal["key", "value", "unit", "context", "record_key"]
ProfileFormat = Literal["auto", "parsing-profile-3.0", "v2-template", "v1-parsing-template", "generic-keyvalue"]
SheetBindings = dict[Key, Annotated[list[Identifier], Field(min_length=1, max_length=200)]]


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid")

    def payload(self):
        # 생략한 기본값과 명시한 null을 구분해 멱등 해시가 같은 요청에 같게 나온다.
        return self.model_dump(mode="json", exclude_unset=True)


class RegisterRequest(Contract):
    source_refs: Annotated[list[Annotated[str, Field(min_length=1, max_length=2048)]], Field(min_length=1, max_length=100)]
    provider: Identifier = "local-xlsx"
    document_id: Identifier | None = None


class DocumentDeleteRequest(Contract):
    """§4.13 다중 삭제 본문. 상한(200개)은 service가 TOO_MANY_DOCUMENTS로 돌려주므로 여기서는 넉넉히만 막는다."""

    document_ids: Annotated[list[Identifier], Field(max_length=5000)]
    purge_source: bool = False


class ApplicationRequest(Contract):
    profile_id: Identifier
    sheet_bindings: SheetBindings | None = None


class RegionInput(Contract):
    role: RegionRole
    sheet_id: Identifier
    range: Annotated[str, Field(min_length=2, max_length=40)]


class RevisionRequest(Contract):
    expected_seq: int = Field(ge=0, strict=True)
    status: ReviewStatus
    field_key: Key | None = None
    effective_spec: dict[str, Any] | None = None
    regions: Annotated[list[RegionInput], Field(max_length=1000)] | None = None
    reason: Annotated[str, Field(max_length=2000)] | None = None
    extract: bool = True

    @model_validator(mode="before")
    @classmethod
    def nonnull_spec(cls, value):
        if isinstance(value, dict) and "effective_spec" in value and value["effective_spec"] is None:
            raise ValueError("effective_spec는 null 대신 필드를 생략하세요.")
        return value


class RollbackRequest(Contract):
    expected_seq: int = Field(ge=0, strict=True)
    target_revision_id: Identifier
    reason: Annotated[str, Field(max_length=2000)] | None = None


class ApproveAllRequest(Contract):
    reason: Annotated[str, Field(max_length=2000)] | None = None
    extract: bool = True


class ProfileCreateRequest(Contract):
    name: Annotated[str, Field(min_length=1, max_length=200)] | None = None
    schema_key: Key
    definition: dict[str, Any]
    format: ProfileFormat = "auto"


class ProfileUpdateRequest(Contract):
    name: Annotated[str, Field(min_length=1, max_length=200)] | None = None
    definition: dict[str, Any]
    format: ProfileFormat = "auto"


class ImportPreviewRequest(Contract):
    schema_key: Key
    definition: dict[str, Any]
    format: ProfileFormat = "auto"


class ProfileTestRequest(Contract):
    snapshot_id: Identifier


class ProfileApproveRequest(Contract):
    application_id: Identifier


class ReparseRequest(Contract):
    mode: Literal["fill", "rematch"]


class SchemaDefinitionRequest(Contract):
    definition: dict[str, Any]


class FieldCreateRequest(Contract):
    field_key: Key
    name: Annotated[str, Field(min_length=1, max_length=200)]
    type: Literal["text", "decimal", "boolean", "date", "datetime", "group"] = "text"
    unit: Annotated[str, Field(max_length=64)] | None = None
    description: Annotated[str, Field(max_length=4000)] | None = None
    aliases: Annotated[list[Annotated[str, Field(min_length=1, max_length=200)]], Field(max_length=100)] | None = None
    parent_field_key: Key | None = None


class FieldPatchRequest(Contract):
    name: Annotated[str, Field(min_length=1, max_length=200)] | None = None
    description: Annotated[str, Field(max_length=4000)] | None = None
    aliases: Annotated[list[Annotated[str, Field(min_length=1, max_length=200)]], Field(max_length=100)] | None = None
    status: Literal["active", "deprecated"] | None = None


class BuildCandidatesRequest(Contract):
    document_ids: Annotated[list[Identifier], Field(min_length=1, max_length=5000)]
    schema_key: Key | None = None


class BuildColumn(Contract):
    field_key: Key
    header: Annotated[str, Field(max_length=200)]
    target_unit: Annotated[str, Field(max_length=64)] | None = None


class BuildPreviewRequest(Contract):
    document_ids: Annotated[list[Identifier], Field(min_length=1, max_length=5000)]
    schema_key: Key
    columns: Annotated[list[BuildColumn], Field(min_length=1, max_length=500)]
    row_mode: Literal["record", "document"] = "record"


class BuildRequest(BuildPreviewRequest):
    format: Literal["csv", "xlsx", "sqlite"] = "xlsx"


class QueueActionRequest(Contract):
    action: Literal["assign_profile", "approve_all", "reparse"]
    profile_id: Identifier | None = None
    sheet_bindings: SheetBindings | None = None
    extract: bool = True
    mode: Literal["fill", "rematch"] | None = None


class JobResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")

    job_id: str
    kind: str
    state: str
    completed: int = 0
    total: int | None = None
    result: dict[str, Any] | None = None
    error_code: str | None = None
    error_message: str | None = None
    target_kind: str | None = None
    target_id: str | None = None
    label: str | None = None
    created_at: str
    started_at: str | None = None
    finished_at: str | None = None
