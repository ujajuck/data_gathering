// 작은 공용 UI 조각: 제목·칩·탭·모달(inert 형제 + 초점 가두기 + Escape).
import { useEffect, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import type { ChipClass, DocumentStatus, DocumentStatusDetail, ProfileStatus } from "./types";
import { APPLICATION_STATE_CLASS, APPLICATION_STATE_LABELS, PROFILE_STATUS_CLASS, PROFILE_STATUS_LABELS, STATUS_CLASS, STATUS_LABELS } from "./types";

export function Heading({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="app-heading">
      <div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="app-heading-actions">{actions}</div>}
    </div>
  );
}

export function Chip({ kind = "muted", children, title }: { kind?: ChipClass | "blue"; children: ReactNode; title?: string }) {
  return (
    <span className={"app-chip " + kind} title={title}>
      {children}
    </span>
  );
}

// 상태 근거(status_detail)를 툴팁 문장으로. 객체면 항목별 요약, 잠김이면 last_error를 우선한다.
export function statusDetailText(detail: DocumentStatusDetail | string | null | undefined, lastError?: string | null): string | undefined {
  if (typeof detail === "string") return detail || lastError || undefined;
  if (!detail || typeof detail !== "object") return lastError || undefined;
  const parts: string[] = [];
  if (detail.locked) parts.push(lastError || `잠김 · ${detail.locked.code || "DRM"}`);
  if (detail.applications) parts.push(`적용 프로파일 ${detail.applications}개`);
  if (detail.unapproved) parts.push(`검수 필요 ${detail.unapproved}건`);
  if (detail.inherited) parts.push(`변경 감지 ${detail.inherited}건`);
  if (detail.failed?.length) parts.push(`파싱 실패 ${detail.failed.length}건`);
  if (detail.incompatible?.length) parts.push(`불일치 ${detail.incompatible.length}건`);
  if (!parts.length && lastError) parts.push(lastError);
  return parts.join(" · ") || undefined;
}

export function StatusChip({ status, detail }: { status: DocumentStatus | string; detail?: string | null }) {
  const known = status in STATUS_LABELS ? (status as DocumentStatus) : null;
  return (
    <Chip kind={known ? STATUS_CLASS[known] : "muted"} title={detail || undefined}>
      {known ? STATUS_LABELS[known] : status}
    </Chip>
  );
}

export function ProfileStatusChip({ status }: { status: ProfileStatus | string }) {
  const known = status in PROFILE_STATUS_LABELS ? (status as ProfileStatus) : null;
  return <Chip kind={known ? PROFILE_STATUS_CLASS[known] : "muted"}>{known ? PROFILE_STATUS_LABELS[known] : status}</Chip>;
}

export type TabItem<T extends string> = { id: T; label: ReactNode; disabled?: boolean };

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
}: {
  tabs: TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  label: string;
}) {
  return (
    <div className="app-tabs" role="tablist" aria-label={label}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={value === tab.id}
          disabled={tab.disabled}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])';
function tabbable(el: HTMLElement) {
  const closed = el.closest("details:not([open])");
  return !closed || (el.tagName === "SUMMARY" && el.parentElement === closed);
}

// 모달: 배경 클릭·닫기 버튼·Escape로 닫힌다. 호출자는 뒤 화면을 inert로 닫아 둔다.
export function Modal({
  label,
  title,
  onClose,
  children,
  actions,
  className = "",
  head,
  viewKey,
  inert = false,
  dismissible = true,
}: {
  label: string;
  title?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
  head?: ReactNode;
  // 대화상자 안에서 화면을 바꿀 때(값이 바뀌면) 초점을 패널로 되돌린다.
  viewKey?: string | number;
  // 이 모달 위에 다른 확인 대화상자가 떠 있는 동안 뒤로 물러난다(aria-modal 대화상자가 둘 동시에 살아 있지 않게).
  inert?: boolean;
  // false면 Escape·배경 클릭·× 가 닫지 않는다 — 되돌릴 수 없는 요청이 도는 중에는 '취소'만 비활성으로 두고
  // 다른 길로 닫히면 사용자는 취소했다고 믿는데 삭제는 끝까지 간다(§7).
  dismissible?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  // 화면 전환으로 누른 버튼이 사라지면 초점이 body로 떨어져 Esc가 죽고 Tab이 대화상자 밖으로 샌다.
  // 초점이 패널 밖으로 나갔을 때만 되돌린다(패널 안에서 입력 중이면 건드리지 않는다).
  useEffect(() => {
    if (viewKey === undefined) return;
    const active = document.activeElement as HTMLElement | null;
    if (!panel.current || !active || !panel.current.contains(active)) panel.current?.focus();
  }, [viewKey]);
  function onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.defaultPrevented) return;
    if (e.key === "Escape") {
      e.stopPropagation();
      if (dismissible) onClose();
      return;
    }
    if (e.key !== "Tab" || !panel.current) return;
    const focusable = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(tabbable);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    const inside = !!active && panel.current.contains(active);
    if (!first) {
      e.preventDefault();
      panel.current.focus();
    } else if (e.shiftKey && (!inside || active === first || active === panel.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (!inside || active === last)) {
      e.preventDefault();
      first.focus();
    }
  }
  return (
    <>
      <div className="app-modal-backdrop" onClick={dismissible && !inert ? onClose : undefined} aria-hidden="true" />
      <div
        className={"app-modal " + className}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        ref={panel}
        inert={inert || undefined}
        onKeyDown={onKeyDown}
      >
        <div className="app-modal-head">
          {title !== undefined ? <h2>{title}</h2> : null}
          {head}
          <button type="button" className="app-modal-close" aria-label="닫기" disabled={!dismissible} onClick={onClose}>
            ×
          </button>
        </div>
        <div className="app-modal-body">{children}</div>
        {actions && <div className="app-modal-actions">{actions}</div>}
      </div>
    </>
  );
}

export function ZoomControl({ value, onChange }: { value: number; onChange: (zoom: number) => void }) {
  const step = (delta: number) => onChange(Math.min(1.5, Math.max(0.5, Math.round((value + delta) * 10) / 10)));
  return (
    <span className="app-inline" role="group" aria-label="확대">
      <button type="button" className="small" aria-label="축소" disabled={value <= 0.5} onClick={() => step(-0.1)}>
        −
      </button>
      <span className="app-small">{Math.round(value * 100)}%</span>
      <button type="button" className="small" aria-label="확대" disabled={value >= 1.5} onClick={() => step(0.1)}>
        +
      </button>
    </span>
  );
}

// 자원과 무관한 빈 상태(초안이 비었을 때 등). State의 빈 상태와 같은 마크업을 쓴다.
export function EmptyState({ children, action, className = "" }: { children: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={className ? "app-empty " + className : "app-empty"}>
      <p>{children}</p>
      {action && <div className="app-empty-action">{action}</div>}
    </div>
  );
}

// 프로파일 적용 상태 칩(types.ts의 APPLICATION_STATE_* 표 공용).
export function ApplicationStateChip({ state }: { state: string | null | undefined }) {
  const known = state ? APPLICATION_STATE_LABELS[state] : undefined;
  return <Chip kind={(state && APPLICATION_STATE_CLASS[state]) || "muted"}>{known || state || "-"}</Chip>;
}
