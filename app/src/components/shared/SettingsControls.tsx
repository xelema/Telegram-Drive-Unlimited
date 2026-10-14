import type { ReactNode } from 'react';

interface SettingsRowProps {
  icon?: ReactNode;
  title: string;
  description: string;
  control: ReactNode;
}

export function SettingsRow({ icon, title, description, control }: SettingsRowProps) {
  return (
    <div className="settings-row">
      <div className="settings-row-copy">
        {icon && <span className="settings-row-icon" aria-hidden="true">{icon}</span>}
        <div className="min-w-0">
          <p className="settings-row-title">{title}</p>
          <p className="settings-row-description">{description}</p>
        </div>
      </div>
      <div className="settings-row-control">{control}</div>
    </div>
  );
}

interface SettingsToggleProps {
  checked: boolean;
  label: string;
  onChange: () => void;
  disabled?: boolean;
}

export function SettingsToggle({ checked, label, onChange, disabled = false }: SettingsToggleProps) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label}
      onClick={onChange} disabled={disabled} className="settings-switch">
      <span className="settings-switch-track" aria-hidden="true">
        <span className="settings-switch-thumb" />
      </span>
    </button>
  );
}

interface SettingsStepperProps {
  value: number;
  minimum: number;
  maximum: number;
  label: string;
  onChange: (value: number) => void;
}

export function SettingsStepper({ value, minimum, maximum, label, onChange }: SettingsStepperProps) {
  return (
    <div className="settings-stepper" role="group" aria-label={label}>
      <button type="button" onClick={() => onChange(Math.max(minimum, value - 1))}
        disabled={value <= minimum} aria-label={`Decrease ${label}`}>−</button>
      <span className="tabular-nums">{value}</span>
      <button type="button" onClick={() => onChange(Math.min(maximum, value + 1))}
        disabled={value >= maximum} aria-label={`Increase ${label}`}>+</button>
    </div>
  );
}
