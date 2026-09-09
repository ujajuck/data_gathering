import { useState } from "react";
import { State, usePage } from "./client";
import type { Row } from "./client";

export default function Presets({
  value,
  onChange,
}: {
  value: Row;
  onChange: (normal: Row) => void;
}) {
  const presets = usePage("/normalization-presets");
  const selected =
    value.preset_id || (value.operation === "identity" ? "identity" : "");
  return (
    <>
      <label>
        전처리 프리셋
        <select
          value={selected}
          onChange={(e) => {
            const item = presets.data?.items.find(
              (p) => p.id === e.target.value,
            );
            if (item) onChange(structuredClone(item.normalization));
          }}
        >
          <option value="">직접 지정한 변환</option>
          {presets.data?.items.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      <State resource={presets} />
      <p className="v2-muted">
        연산을 이 버전에 고정합니다. 원본은 보존되며, 비율 변환은 목표 단위를
        비워 지정하세요.
      </p>
    </>
  );
}

export function TemplatePresets({
  source,
  onChange,
}: {
  source: string;
  onChange: (source: string) => void;
}) {
  const [normal, setNormal] = useState<Row>({
    operation: "identity",
    version: "1",
  });
  const [rule, setRule] = useState("");
  const [message, setMessage] = useState("");
  return (
    <details className="v2-details">
      <summary>양식 규칙 전처리</summary>
      <label>
        적용할 규칙 이름
        <input
          value={rule}
          onChange={(e) => setRule(e.target.value)}
          placeholder="rule_key"
        />
      </label>
      <Presets value={normal} onChange={setNormal} />
      <button
        onClick={() => {
          try {
            const definition = JSON.parse(source);
            const target = definition.rules?.find(
              (r: Row) => r.rule_key === rule,
            );
            if (!target)
              throw new Error("템플릿에 있는 규칙 이름을 지정하세요.");
            target.value_spec = {
              ...target.value_spec,
              normalization: structuredClone(normal),
            };
            onChange(JSON.stringify(definition, null, 2));
            setMessage("초안에 반영했습니다. 새 템플릿 버전으로 저장하세요.");
          } catch (e) {
            setMessage((e as Error).message);
          }
        }}
      >
        규칙 초안에 반영
      </button>
      {message && <p role="status">{message}</p>}
    </details>
  );
}
