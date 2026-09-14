// 규칙 탭(§7 Profiles): 규칙 카드(rule_name/rule_key · 필드 · key/value/unit/context 선택자 요약 · type/unit/normalization)
// + 폼 편집기. 폼은 canonical JSON 모델(profileModel.ts)을 불변으로 고쳐 PUT /profiles/{id} {definition}으로 저장한다.
import { useEffect, useState } from "react";
import { State, useData } from "./client";
import type { Resource } from "./client";
import type { NormalizationPreset, Page, ProfileDetail, SchemaTree, SchemaTreeNode } from "./types";
import { Chip, EmptyState } from "./ui";
import {
  AREA_KINDS,
  AXES,
  CARDINALITIES,
  SELECTOR_ROLES,
  VALUE_TYPES,
  anchorNames,
  areaKind,
  emptyArea,
  normalizationLabel,
  replaceRule,
  selectorSummary,
  setRoleArea,
  setRoleOption,
  sheetRoleNames,
  splitTexts,
} from "./profileModel";
import type { AreaKind, AreaSpec, ProfileDefinition, RuleSpec, SelectorRole } from "./profileModel";

export default function ProfileRules({
  profile,
  definition,
  onSave,
}: {
  profile: ProfileDetail;
  definition: Resource<ProfileDefinition>;
  onSave: (next: ProfileDefinition) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState<RuleSpec | null>(null);
  const [saving, setSaving] = useState(false);
  const def = definition.data;
  const rules = def?.rules || [];
  const fieldName = (rule: RuleSpec) => {
    const summary = profile.rules.find((r) => r.rule_key === rule.rule_key);
    if (summary?.field) return summary.field.name;
    return rule.field_key || "";
  };
  async function save(rule: RuleSpec, original: string) {
    if (!def) return;
    setSaving(true);
    const ok = await onSave(replaceRule(def, original, rule));
    setSaving(false);
    if (ok) setEditing(null);
  }
  async function remove(rule: RuleSpec) {
    if (!def) return;
    setSaving(true);
    await onSave(replaceRule(def, rule.rule_key, null));
    setSaving(false);
  }
  function add() {
    const roles = sheetRoleNames(def);
    const role = roles[0] || "main";
    let n = rules.length + 1;
    while (rules.some((r) => r.rule_key === `rule_${n}`)) n++;
    setEditing({
      rule_key: `rule_${n}`,
      rule_name: `규칙 ${n}`,
      selector: {
        key: { areas: [emptyArea("find", role)], repeat: "once" },
        value: { areas: [emptyArea("relative", role)], cardinality: "scalar" },
      },
      value_spec: { type: "text" },
    });
  }
  return (
    <div className="app-stack">
      <State resource={definition} isEmpty={false} />
      {def && editing && (
        <RuleForm
          key={editing.rule_key}
          rule={editing}
          definition={def}
          schemaKey={profile.schema?.key || ""}
          isNew={!rules.some((r) => r.rule_key === editing.rule_key)}
          saving={saving}
          onCancel={() => setEditing(null)}
          onSave={(rule) => save(rule, editing.rule_key)}
        />
      )}
      {def && !editing && (
        <>
          <div className="app-toolbar">
            <span className="app-muted app-small">파싱 규칙 {rules.length}개 · 시트 역할 {sheetRoleNames(def).join(", ") || "없음"}</span>
            <button type="button" className="app-toolbar-end small primary" onClick={add} disabled={saving}>
              + 규칙 추가
            </button>
          </div>
          {rules.length === 0 && (
            <EmptyState
              action={
                <button type="button" className="primary" onClick={add}>
                  + 규칙 추가
                </button>
              }
            >
              파싱 규칙이 없습니다.
            </EmptyState>
          )}
          <div className="app-stack" aria-label="파싱 규칙 목록">
            {rules.map((rule) => (
              <article className="app-card tight app-rule-card" key={rule.rule_key} aria-label={rule.rule_name || rule.rule_key}>
                <div className="app-card-head">
                  <div className="app-inline">
                    <strong>{rule.rule_name || rule.rule_key}</strong>
                    <code>{rule.rule_key}</code>
                    {fieldName(rule) ? <Chip kind="ok">→ {fieldName(rule)}</Chip> : <Chip kind="warn">필드 미지정</Chip>}
                  </div>
                  <div className="app-inline">
                    <button type="button" className="small" onClick={() => setEditing(rule)} disabled={saving}>
                      편집
                    </button>
                    <button type="button" className="small danger" onClick={() => remove(rule)} disabled={saving}>
                      삭제
                    </button>
                  </div>
                </div>
                <dl className="app-kv">
                  {SELECTOR_ROLES.map((role) => {
                    const summary = selectorSummary(rule, role.id);
                    return summary ? (
                      <RoleLine key={role.id} label={role.label} text={summary} />
                    ) : null;
                  })}
                  <dt>값</dt>
                  <dd>
                    {String(rule.value_spec?.type || "text")}
                    {rule.value_spec?.unit ? ` · ${rule.value_spec.unit}` : ""} · {normalizationLabel(rule.value_spec)}
                  </dd>
                </dl>
              </article>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function RoleLine({ label, text }: { label: string; text: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{text}</dd>
    </>
  );
}

// ---------------------------------------------------------------- 폼

function leafFields(nodes: SchemaTreeNode[], out: { key: string; name: string }[] = []): { key: string; name: string }[] {
  for (const node of nodes) {
    if (node.children?.length) leafFields(node.children, out);
    else if (node.type !== "group") out.push({ key: node.field_key, name: node.name });
  }
  return out;
}

function RuleForm({
  rule: initial,
  definition,
  schemaKey,
  isNew,
  saving,
  onCancel,
  onSave,
}: {
  rule: RuleSpec;
  definition: ProfileDefinition;
  schemaKey: string;
  isNew: boolean;
  saving: boolean;
  onCancel: () => void;
  onSave: (rule: RuleSpec) => void;
}) {
  const [rule, setRule] = useState<RuleSpec>(initial);
  const [presetId, setPresetId] = useState("");
  const presets = useData<Page<NormalizationPreset> | NormalizationPreset[]>("/normalization-presets");
  const presetList = Array.isArray(presets.data) ? presets.data : presets.data?.items ?? [];
  const tree = useData<SchemaTree>(schemaKey ? `/schemas/${encodeURIComponent(schemaKey)}/tree` : null);
  const fields = tree.data ? leafFields(tree.data.nodes || []) : [];
  const roles = sheetRoleNames(definition);
  const anchors = anchorNames(definition);
  const keyError = !rule.rule_key.trim() ? "규칙 키는 비울 수 없습니다." : isNew && (definition.rules || []).some((r) => r.rule_key === rule.rule_key) ? "이미 있는 규칙 키입니다." : "";
  useEffect(() => {
    setRule(initial);
  }, [initial]);
  const setValueSpec = (patch: Record<string, unknown>) => {
    const next = { ...(rule.value_spec || {}), ...patch };
    for (const key of Object.keys(patch)) if (patch[key] === "" || patch[key] === undefined) delete next[key];
    setRule({ ...rule, value_spec: next });
  };
  const choosePreset = (id: string) => {
    setPresetId(id);
    const preset = presetList.find((p) => p.id === id);
    if (preset) setValueSpec({ normalization: preset.normalization });
  };
  return (
    <form
      className="app-card tight app-rule-form"
      aria-label={isNew ? "규칙 추가" : "규칙 편집"}
      onSubmit={(e) => {
        e.preventDefault();
        if (!keyError) onSave(rule);
      }}
    >
      <div className="app-card-head">
        <h3>{isNew ? "규칙 추가" : `규칙 편집 · ${initial.rule_name || initial.rule_key}`}</h3>
      </div>
      <div className="app-form-grid">
        <label>
          규칙 이름
          <input value={rule.rule_name || ""} onChange={(e) => setRule({ ...rule, rule_name: e.target.value })} />
        </label>
        <label>
          규칙 키
          <input value={rule.rule_key} readOnly={!isNew} aria-invalid={keyError ? true : undefined} onChange={(e) => setRule({ ...rule, rule_key: e.target.value.trim() })} />
        </label>
        <label>
          필드
          {fields.length > 0 ? (
            <select
              value={rule.field_key || ""}
              onChange={(e) => {
                const next = { ...rule };
                if (e.target.value) next.field_key = e.target.value;
                else delete next.field_key;
                setRule(next);
              }}
            >
              <option value="">(미지정)</option>
              {rule.field_key && !fields.some((f) => f.key === rule.field_key) && <option value={rule.field_key}>{rule.field_key}</option>}
              {fields.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.name} ({f.key})
                </option>
              ))}
            </select>
          ) : (
            <input
              value={rule.field_key || ""}
              placeholder="field_key"
              onChange={(e) => {
                const next = { ...rule };
                if (e.target.value.trim()) next.field_key = e.target.value.trim();
                else delete next.field_key;
                setRule(next);
              }}
            />
          )}
        </label>
      </div>
      {keyError && (
        <p className="app-error" role="alert">
          {keyError}
        </p>
      )}
      {SELECTOR_ROLES.map((role) => (
        <RoleEditor key={role.id} role={role.id} label={role.label} rule={rule} roles={roles} anchors={anchors} onChange={setRule} />
      ))}
      <fieldset className="app-fieldset">
        <legend>값</legend>
        <div className="app-form-grid">
          <label>
            값 타입
            <select value={String(rule.value_spec?.type || "text")} onChange={(e) => setValueSpec({ type: e.target.value })}>
              {VALUE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
              {rule.value_spec?.type && !VALUE_TYPES.includes(String(rule.value_spec.type)) && <option value={String(rule.value_spec.type)}>{String(rule.value_spec.type)}</option>}
            </select>
          </label>
          <label>
            단위
            <input value={String(rule.value_spec?.unit || "")} placeholder="예: °C" onChange={(e) => setValueSpec({ unit: e.target.value })} />
          </label>
          <label>
            정규화 프리셋
            <select value={presetId} onChange={(e) => choosePreset(e.target.value)}>
              <option value="">(현재: {normalizationLabel(rule.value_spec)})</option>
              {presetList.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </fieldset>
      <div className="app-toolbar">
        <button type="submit" className="primary" disabled={saving || !!keyError}>
          규칙 저장
        </button>
        <button type="button" onClick={onCancel} disabled={saving}>
          취소
        </button>
        <span className="app-muted app-small app-toolbar-end">저장하면 새 리비전이 만들어집니다.</span>
      </div>
    </form>
  );
}

function RoleEditor({
  role,
  label,
  rule,
  roles,
  anchors,
  onChange,
}: {
  role: SelectorRole;
  label: string;
  rule: RuleSpec;
  roles: string[];
  anchors: string[];
  onChange: (rule: RuleSpec) => void;
}) {
  const selector = rule.selector?.[role];
  const area = selector?.areas?.[0];
  const extra = (selector?.areas?.length || 0) - 1;
  const defaultRole = roles[0] || "";
  if (!area) {
    return (
      <fieldset className="app-fieldset">
        <legend>{label}</legend>
        <button type="button" className="small" onClick={() => onChange(setRoleArea(rule, role, 0, emptyArea(role === "value" ? "relative" : "find", defaultRole)))}>
          + {label} 선택자 추가
        </button>
      </fieldset>
    );
  }
  const update = (next: AreaSpec) => onChange(setRoleArea(rule, role, 0, next));
  const kind = areaKind(area);
  const changeKind = (nextKind: AreaKind) => {
    if (nextKind !== kind) update(emptyArea(nextKind, area.sheet_role || defaultRole));
  };
  const find = area.find || {};
  const relative = area.relative || { row: 0, col: 0 };
  const num = (value: string, fallback = 0) => (value === "" || Number.isNaN(Number(value)) ? fallback : Number(value));
  return (
    <fieldset className="app-fieldset">
      <legend>{label}</legend>
      <div className="app-form-grid">
        <label>
          {label} 시트 역할
          <select value={area.sheet_role || ""} onChange={(e) => update({ ...area, sheet_role: e.target.value })}>
            {!roles.includes(area.sheet_role || "") && <option value={area.sheet_role || ""}>{area.sheet_role || "(선택)"}</option>}
            {roles.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <label>
          {label} 위치 종류
          <select value={kind} onChange={(e) => changeKind(e.target.value as AreaKind)}>
            {AREA_KINDS.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
              </option>
            ))}
          </select>
        </label>
        {kind === "range" && (
          <label>
            {label} 범위
            <input value={area.range || ""} placeholder="A1:B2" onChange={(e) => update({ ...area, range: e.target.value.trim() })} />
          </label>
        )}
        {kind === "find" && (
          <>
            <label>
              {label} 찾을 텍스트
              <input
                value={(find.texts || []).join(", ")}
                placeholder="쉼표로 구분"
                onChange={(e) => {
                  const next = { ...find, texts: splitTexts(e.target.value) };
                  delete next.regex;
                  update({ ...area, find: next });
                }}
              />
            </label>
            <label>
              {label} 정규식
              <input
                value={find.regex || ""}
                placeholder="^(배치|LOT)$"
                onChange={(e) => {
                  const next = { ...find };
                  if (e.target.value) {
                    next.regex = e.target.value;
                    delete next.texts;
                  } else delete next.regex;
                  update({ ...area, find: next });
                }}
              />
            </label>
            <label>
              {label} 검색 범위
              <input value={find.within || ""} placeholder="A1:AZ100" onChange={(e) => update({ ...area, find: { ...find, within: e.target.value.trim() || undefined } })} />
            </label>
            <label>
              {label} 몇 번째
              <input
                type="number"
                min={0}
                value={find.occurrence ?? ""}
                onChange={(e) => {
                  const next = { ...find };
                  if (e.target.value === "") delete next.occurrence;
                  else next.occurrence = num(e.target.value);
                  update({ ...area, find: next });
                }}
              />
            </label>
          </>
        )}
        {kind === "relative" && (
          <>
            <label>
              {label} 행 오프셋
              <input type="number" value={relative.row ?? 0} onChange={(e) => update({ ...area, relative: { ...relative, row: num(e.target.value) } })} />
            </label>
            <label>
              {label} 열 오프셋
              <input type="number" value={relative.col ?? 0} onChange={(e) => update({ ...area, relative: { ...relative, col: num(e.target.value) } })} />
            </label>
            <label>
              {label} 행 수
              <input type="number" min={1} value={relative.rows ?? 1} onChange={(e) => update({ ...area, relative: { ...relative, rows: num(e.target.value, 1) } })} />
            </label>
            <label>
              {label} 열 수
              <input type="number" min={1} value={relative.cols ?? 1} onChange={(e) => update({ ...area, relative: { ...relative, cols: num(e.target.value, 1) } })} />
            </label>
            <label>
              {label} 기준 앵커
              <select
                value={relative.anchor || ""}
                onChange={(e) => {
                  const next = { ...relative };
                  if (e.target.value) next.anchor = e.target.value;
                  else delete next.anchor;
                  update({ ...area, relative: next });
                }}
              >
                <option value="">(이 규칙의 키)</option>
                {anchors.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        {kind === "anchor" && (
          <label>
            {label} 앵커
            <select value={area.anchor || ""} onChange={(e) => update({ ...area, anchor: e.target.value })}>
              <option value="">(선택)</option>
              {anchors.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </label>
        )}
        {role === "key" && (
          <label>
            {label} 반복
            <select value={selector?.repeat || "once"} onChange={(e) => onChange(setRoleOption(rule, role, "repeat", e.target.value === "once" ? "" : e.target.value))}>
              <option value="once">once</option>
              <option value="each">each</option>
            </select>
          </label>
        )}
        {role === "value" && (
          <>
            <label>
              값 개수
              <select value={selector?.cardinality || "scalar"} onChange={(e) => onChange(setRoleOption(rule, role, "cardinality", e.target.value))}>
                {CARDINALITIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <label>
              값 방향
              <select value={selector?.axis || "none"} onChange={(e) => onChange(setRoleOption(rule, role, "axis", e.target.value))}>
                {AXES.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
      </div>
      <div className="app-inline app-small app-muted">
        {extra > 0 && <span>추가 영역 {extra}개는 JSON 탭에서 편집합니다.</span>}
        {role !== "key" && role !== "value" && (
          <button type="button" className="link small" onClick={() => onChange(setRoleArea(rule, role, 0, null))}>
            {label} 선택자 제거
          </button>
        )}
      </div>
    </fieldset>
  );
}
