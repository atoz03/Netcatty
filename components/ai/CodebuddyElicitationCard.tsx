import React, { useCallback, useId, useMemo, useState } from 'react';
import { MessageCircleQuestion } from 'lucide-react';
import { useI18n } from '../../application/i18n/I18nProvider';
import {
  buildCodebuddyElicitationContent,
  initialCodebuddyElicitationValues,
  parseCodebuddyElicitationFields,
  selectedCodebuddyOptionKey,
  toggleCodebuddyArrayOption,
  validateCodebuddyElicitationValues,
  type CodebuddyElicitationField,
  type CodebuddyElicitationValidationIssue,
} from '../../domain/codebuddyElicitationForm';
import type {
  CodebuddyElicitation,
  CodebuddyElicitationAction,
} from '../../infrastructure/ai/shared/codebuddyElicitations';
import { Button } from '../ui/button';

function validationMessage(
  validationIssue: CodebuddyElicitationValidationIssue,
  t: ReturnType<typeof useI18n>['t'],
): string {
  const values = {
    field: validationIssue.fieldTitle,
    limit: validationIssue.limit,
    format: validationIssue.format,
  };
  return t(`ai.codebuddy.elicitation.validation.${validationIssue.code}`, values);
}

function inputType(field: CodebuddyElicitationField): React.HTMLInputTypeAttribute {
  if (field.type === 'number' || field.type === 'integer') return 'number';
  if (field.format === 'email') return 'email';
  if (field.format === 'uri') return 'url';
  if (field.format === 'date') return 'date';
  return 'text';
}

export const CodebuddyElicitationCard: React.FC<{
  elicitation: CodebuddyElicitation;
  onRespond: (
    action: CodebuddyElicitationAction,
    content?: Record<string, unknown>,
  ) => Promise<void>;
}> = ({ elicitation, onRespond }) => {
  const { t } = useI18n();
  const formId = useId();
  const fields = useMemo(
    () => parseCodebuddyElicitationFields(elicitation.request.requestedSchema),
    [elicitation.request.requestedSchema],
  );
  const [values, setValues] = useState<Record<string, unknown>>(
    () => initialCodebuddyElicitationValues(fields),
  );
  const [touchedFields, setTouchedFields] = useState<Set<string>>(() => new Set());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const validationIssues = validateCodebuddyElicitationValues(fields, values);
  const validationByField = new Map(
    validationIssues.map((validationIssue) => [validationIssue.fieldId, validationIssue]),
  );
  const complete = validationIssues.length === 0;

  const markFieldTouched = useCallback((fieldId: string) => {
    setTouchedFields((current) => {
      if (current.has(fieldId)) return current;
      const next = new Set(current);
      next.add(fieldId);
      return next;
    });
  }, []);

  const respond = async (
    action: CodebuddyElicitationAction,
    content?: Record<string, unknown>,
  ) => {
    if (submitting) return;
    setSubmitting(true);
    setError('');
    try {
      await onRespond(action, content);
    } catch (responseError) {
      setError(responseError instanceof Error ? responseError.message : String(responseError));
      setSubmitting(false);
    }
  };

  return (
    <div className="rounded-lg border border-blue-500/30 bg-card/70 p-3 space-y-3">
      <div className="flex items-start gap-2">
        <MessageCircleQuestion size={16} className="mt-0.5 shrink-0 text-blue-500" />
        <div className="min-w-0">
          <div className="text-sm font-medium">{t('ai.codebuddy.elicitation.title')}</div>
          <div className="text-xs text-muted-foreground leading-5">
            {elicitation.request.message || t('ai.codebuddy.elicitation.description')}
          </div>
        </div>
      </div>

      {fields.map((field, fieldIndex) => {
        const validationIssue = validationByField.get(field.id);
        const visibleValidationIssue = validationIssue
          && (values[field.id] !== undefined || touchedFields.has(field.id))
          ? validationIssue
          : undefined;
        const errorId = visibleValidationIssue
          ? `${formId}-field-${fieldIndex}-error`
          : undefined;
        return (
          <div key={field.id} className="block space-y-1.5">
            <span className="text-xs font-medium">
              {field.title}{field.required ? ' *' : ''}
            </span>
            {field.description ? (
              <span className="block text-[11px] text-muted-foreground">{field.description}</span>
            ) : null}
            {field.type === 'array' && field.options.length > 0 ? (
              <div
                className="space-y-1.5"
                role="group"
                aria-invalid={Boolean(visibleValidationIssue)}
                aria-describedby={errorId}
              >
                {field.options.map((option) => {
                  const selected = Array.isArray(values[field.id])
                    ? values[field.id] as unknown[]
                    : [];
                  const checked = selected.some((value) => Object.is(value, option.value));
                  const maximumReached = field.maxItems !== undefined
                    && selected.length >= field.maxItems;
                  return (
                    <label
                      key={option.key}
                      className="flex items-center gap-2 rounded-md border border-border/50 px-2.5 py-2 text-xs"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={submitting || (!checked && maximumReached)}
                        onChange={(event) => {
                          markFieldTouched(field.id);
                          setValues((current) => {
                            const next = toggleCodebuddyArrayOption(
                              current[field.id],
                              option.value,
                              event.target.checked,
                            );
                            return {
                              ...current,
                              [field.id]: next.length === 0 && !field.required
                                ? undefined
                                : next,
                            };
                          });
                        }}
                      />
                      <span>{option.label}</span>
                    </label>
                  );
                })}
              </div>
            ) : field.options.length > 0 ? (
              <select
                value={selectedCodebuddyOptionKey(field.options, values[field.id])}
                disabled={submitting}
                aria-invalid={Boolean(visibleValidationIssue)}
                aria-describedby={errorId}
                onChange={(event) => {
                  markFieldTouched(field.id);
                  const option = field.options.find(
                    (candidate) => candidate.key === event.target.value,
                  );
                  setValues((current) => ({
                    ...current,
                    [field.id]: option?.value,
                  }));
                }}
                className="h-8 w-full rounded-md border border-input bg-background px-2.5 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="">{t('ai.codebuddy.elicitation.select')}</option>
                {field.options.map((option) => (
                  <option key={option.key} value={option.key}>{option.label}</option>
                ))}
              </select>
            ) : field.type === 'boolean' ? (
              <select
                value={values[field.id] === undefined ? '' : String(values[field.id])}
                disabled={submitting}
                aria-invalid={Boolean(visibleValidationIssue)}
                aria-describedby={errorId}
                onChange={(event) => {
                  markFieldTouched(field.id);
                  const value = event.target.value === ''
                    ? undefined
                    : event.target.value === 'true';
                  setValues((current) => ({ ...current, [field.id]: value }));
                }}
                className="h-8 w-full rounded-md border border-input bg-background px-2.5 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="">{t('ai.codebuddy.elicitation.select')}</option>
                <option value="true">{t('ai.codebuddy.elicitation.yes')}</option>
                <option value="false">{t('ai.codebuddy.elicitation.no')}</option>
              </select>
            ) : (
              <input
                type={inputType(field)}
                min={field.minimum}
                max={field.maximum}
                minLength={field.type === 'string' ? field.minLength : undefined}
                maxLength={field.type === 'string' ? field.maxLength : undefined}
                step={field.type === 'integer' ? 1 : undefined}
                value={String(values[field.id] ?? '')}
                disabled={submitting}
                aria-invalid={Boolean(visibleValidationIssue)}
                aria-describedby={errorId}
                onChange={(event) => {
                  markFieldTouched(field.id);
                  const raw = event.target.value;
                  const value = raw === ''
                    ? field.type === 'string' && field.required
                      ? ''
                      : undefined
                    : field.type === 'number' || field.type === 'integer'
                      ? Number(raw)
                      : raw;
                  setValues((current) => ({ ...current, [field.id]: value }));
                }}
                className="h-8 w-full rounded-md border border-input bg-background px-2.5 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            )}
            {visibleValidationIssue ? (
              <p id={errorId} role="alert" className="text-[11px] text-destructive">
                {validationMessage(visibleValidationIssue, t)}
              </p>
            ) : null}
          </div>
        );
      })}

      {error ? <p className="text-xs text-destructive">{error}</p> : null}

      <div className="flex flex-wrap justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={submitting}
          onClick={() => void respond('cancel')}
        >
          {t('common.cancel')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={submitting}
          onClick={() => void respond('decline')}
        >
          {t('ai.codebuddy.elicitation.decline')}
        </Button>
        <Button
          size="sm"
          disabled={submitting || !complete}
          onClick={() => void respond(
            'accept',
            buildCodebuddyElicitationContent(values, fields),
          )}
        >
          {t('ai.codebuddy.elicitation.accept')}
        </Button>
      </div>
    </div>
  );
};
