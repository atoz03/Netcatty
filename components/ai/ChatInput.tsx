/**
 * ChatInput - Zed-style bottom input area for the AI chat panel
 *
 * Thin wrapper around the AI Elements prompt-input components.
 * Bordered textarea with monospace placeholder, expand toggle,
 * and a bottom toolbar with muted controls + subtle send button.
 */

import { ArrowUp, AtSign, Check, ChevronDown, ChevronRight, Cpu, Eye, FileText, ImageIcon, Loader2, MessageSquare, Package, Plus, ShieldCheck, SquareTerminal, X, Zap } from 'lucide-react';
import {
  buildSlashCommandItems,
  filterQuickMessages,
  filterSystemSlashCommands,
  filterUserSkillsForSlash,
  getSlashCommandItemKey,
  getSystemSlashCommand,
  SYSTEM_BUILTIN_SLASH_COMMANDS,
  type AIQuickMessage,
  type SlashCommandItem,
  type UserSkillSlashOption,
} from '../../infrastructure/ai/quickMessages';
import { SlashCommandPicker } from './SlashCommandPicker';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { createPortal } from 'react-dom';
import type { FormEvent } from 'react';
import {
  PromptInput,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from '../ai-elements/prompt-input';
import type { PromptInputStatus } from '../ai-elements/prompt-input';
import { formatThinkingLabel } from '../../infrastructure/ai/types';
import type { AgentModelPreset, AIPermissionMode, ProviderConfig, UploadedFile } from '../../infrastructure/ai/types';
import { ProviderIconBadge } from '../settings/tabs/ai/ProviderIconBadge';
import { VariableSizeVirtualList, type VariableSizeVirtualListHandle } from '../ui/VariableSizeVirtualList';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import type { AgentContextUsage } from '../../application/state/useAgentCompactionUi';
import {
  CHAT_INPUT_DEFAULT_HEIGHT,
  CHAT_INPUT_MAX_HEIGHT,
  CHAT_INPUT_MIN_HEIGHT,
  CHAT_INPUT_PANEL_RESERVE,
  resolveChatInputAriaHeight,
  resolveChatInputMaxHeight,
  resolveChatInputResizeHeight,
  resolveVisibleChatInputHeight,
  resolveVisibleChatInputMaxHeight,
} from './chatInputResize';

// Keep in sync with the popover's Tailwind max-width below.
const MODEL_PICKER_MAX_WIDTH = 360;
// Slightly wider for the provider picker so the per-row default-model
// caption doesn't truncate.
const PROVIDER_PICKER_MAX_WIDTH = 320;
const PERMISSION_PICKER_WIDTH = 250;
const MENU_VIEWPORT_GUTTER = 8;
const CONTEXT_USAGE_RING_RADIUS = 10;
const CONTEXT_USAGE_RING_CIRCUMFERENCE = 2 * Math.PI * CONTEXT_USAGE_RING_RADIUS;

function formatContextTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(tokens >= 100_000 ? 0 : 1)}K`;
  return String(Math.max(0, Math.round(tokens)));
}

/**
 * Provider picker payload used by Catty Agent. When set, the model chip
 * switches to a flat provider list (provider icon + name + the provider's
 * configured default model as caption) in place of the generic Cpu glyph
 * + model-preset dropdown. Each provider exposes a single model — its
 * `defaultModel` — so a two-level menu would be empty noise; picking a
 * provider implicitly picks its model.
 */
export interface ProviderSwitcherConfig {
  /** Every configured provider — Settings-level visibility, not the
   *  `enabled` toggle, since the user expects to swap between everything
   *  they've set up. */
  providers: ProviderConfig[];
  /** Currently bound provider id (falls back to providers[0] when missing). */
  selectedProviderId?: string;
  /** Currently bound model id under the selected provider. */
  selectedModelId?: string;
  /** Fires when the user picks a (providerId, modelId) pair. */
  onSelect: (providerId: string, modelId: string) => void;
}

interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onCompact?: () => void;
  /** When false, hide/ignore `/compact` so the composer is not cleared as a silent no-op. */
  canCompact?: boolean;
  contextUsage?: AgentContextUsage | null;
  onSteer?: () => void;
  onStop?: () => void;
  isStreaming?: boolean;
  canSteer?: boolean;
  isSteering?: boolean;
  lockTurnConfiguration?: boolean;
  disabled?: boolean;
  providerName?: string;
  modelName?: string;
  agentName?: string;
  placeholder?: string;
  /** Available model presets for the current agent */
  modelPresets?: AgentModelPreset[];
  /** Currently selected model ID */
  selectedModelId?: string;
  /** Callback when user selects a model */
  onModelSelect?: (modelId: string) => void;
  /** Attached files (images, PDFs, etc.) */
  files?: UploadedFile[];
  /** Callback to add files (paste/drop) */
  onAddFiles?: (files: File[]) => void;
  /** Callback to remove a file */
  onRemoveFile?: (id: string) => void;
  /** Available hosts for @ mention */
  hosts?: Array<{ sessionId: string; hostname: string; label: string; connected: boolean }>;
  /** User skills currently selected for the next send */
  selectedUserSkills?: Array<{ id: string; slug: string; name: string; description: string }>;
  /** Available user skills for /skill-slug insertion */
  userSkills?: Array<{ id: string; slug: string; name: string; description: string }>;
  /** Custom slash prompts configured in Settings → AI */
  quickMessages?: AIQuickMessage[];
  /** Callback to add a selected user skill */
  onAddUserSkill?: (slug: string) => void;
  /** Callback to remove a selected user skill */
  onRemoveUserSkill?: (slug: string) => void;
  /** Permission mode (only shown for Catty Agent) */
  permissionMode?: AIPermissionMode;
  /** Callback when user changes permission mode */
  onPermissionModeChange?: (mode: AIPermissionMode) => void;
  /**
   * Provider→model two-level picker payload. When provided, replaces the
   * single-list model dropdown with a provider-aware picker. Used for the
   * Catty Agent only — external SDK agents (Claude/Codex) keep the
   * `modelPresets` dropdown because their provider is wired inside the CLI.
   */
  providerSwitcher?: ProviderSwitcherConfig;
}

const ChatInput: React.FC<ChatInputProps> = ({
  value,
  onChange,
  onSend,
  onCompact,
  canCompact = false,
  contextUsage,
  onSteer,
  onStop,
  isStreaming = false,
  canSteer = false,
  isSteering = false,
  lockTurnConfiguration = false,
  disabled = false,
  providerName,
  modelName,
  agentName,
  placeholder,
  modelPresets = [],
  selectedModelId,
  onModelSelect,
  files = [],
  onAddFiles,
  onRemoveFile,
  hosts = [],
  selectedUserSkills = [],
  userSkills = [],
  quickMessages = [],
  onAddUserSkill,
  onRemoveUserSkill,
  permissionMode,
  onPermissionModeChange,
  providerSwitcher,
}) => {
  const { t } = useI18n();
  const hasTerminalSelectionAttachment = files.some((file) => file.terminalSelection);
  const composerDisabled = disabled || isSteering;
  const [composerHeight, setComposerHeight] = useState<number | null>(null);
  const [composerMaxHeight, setComposerMaxHeight] = useState(CHAT_INPUT_MAX_HEIGHT);
  const composerDesiredHeightRef = useRef<number | null>(null);
  // Consolidate menu state into a single discriminated union to prevent multiple menus open simultaneously
  type ActiveMenu = 'model' | 'attach' | 'atMention' | 'slashCommand' | 'perm' | null;
  const [activeMenu, setActiveMenu] = useState<ActiveMenu>(null);
  const [menuPos, setMenuPos] = useState<{ left: number; bottom: number } | null>(null);
  const [inputPanelPos, setInputPanelPos] = useState<{ left: number; bottom: number; width: number } | null>(null);
  const [hoveredModelId, setHoveredModelId] = useState<string | null>(null);
  const [slashQuery, setSlashQuery] = useState('');
  const [slashRange, setSlashRange] = useState<{ start: number; end: number } | null>(null);
  // Active highlight index for @ mention / slash skill keyboard navigation
  const [activeMenuIndex, setActiveMenuIndex] = useState(0);

  // Derived booleans for readability
  const showModelPicker = activeMenu === 'model';
  const showAttachMenu = activeMenu === 'attach';
  const showAtMention = activeMenu === 'atMention';
  const showSlashCommandPicker = activeMenu === 'slashCommand';
  const showPermPicker = activeMenu === 'perm';

  const closeAllMenus = useCallback(() => {
    setActiveMenu(null);
    setMenuPos(null);
    setInputPanelPos(null);
    setHoveredModelId(null);
    setSlashQuery('');
    setSlashRange(null);
  }, []);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputShellRef = useRef<HTMLDivElement>(null);
  const resizeStartRef = useRef<{
    pointerId: number;
    startY: number;
    startHeight: number;
    maxHeight: number;
    previousUserSelect: string;
    pendingY: number | null;
    frame: number | null;
  } | null>(null);
  const modelBtnRef = useRef<HTMLButtonElement>(null);
  const permBtnRef = useRef<HTMLButtonElement>(null);
  const attachBtnRef = useRef<HTMLButtonElement>(null);
  const slashPickerListRef = useRef<HTMLDivElement>(null);
  const atMentionListRef = useRef<VariableSizeVirtualListHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const getComposerMaxHeight = useCallback(() => {
    const panel = inputShellRef.current?.closest<HTMLElement>('[data-section="ai-chat-panel"]');
    return resolveChatInputMaxHeight(
      panel?.clientHeight ?? CHAT_INPUT_MAX_HEIGHT + CHAT_INPUT_PANEL_RESERVE,
    );
  }, []);

  const applyPendingComposerResize = useCallback(() => {
    const resizeStart = resizeStartRef.current;
    if (!resizeStart) return;
    resizeStart.frame = null;
    if (resizeStart.pendingY == null) return;
    const nextHeight = resolveChatInputResizeHeight(
      resizeStart.startHeight,
      resizeStart.startY,
      resizeStart.pendingY,
      resizeStart.maxHeight,
    );
    resizeStart.pendingY = null;
    composerDesiredHeightRef.current = nextHeight;
    setComposerHeight(nextHeight);
  }, []);

  const finishComposerResize = useCallback((target?: HTMLDivElement, pointerId?: number) => {
    const resizeStart = resizeStartRef.current;
    if (!resizeStart) return;
    if (resizeStart.frame !== null) {
      cancelAnimationFrame(resizeStart.frame);
      applyPendingComposerResize();
    }
    resizeStartRef.current = null;
    document.body.style.userSelect = resizeStart.previousUserSelect;
    if (target && pointerId != null && target.hasPointerCapture(pointerId)) {
      target.releasePointerCapture(pointerId);
    }
  }, [applyPendingComposerResize]);

  const handleComposerResizeStart = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !inputShellRef.current) return;
    event.preventDefault();
    closeAllMenus();
    const maxHeight = getComposerMaxHeight();
    resizeStartRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: inputShellRef.current.getBoundingClientRect().height,
      maxHeight,
      previousUserSelect: document.body.style.userSelect,
      pendingY: null,
      frame: null,
    };
    setComposerMaxHeight(maxHeight);
    document.body.style.userSelect = 'none';
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [closeAllMenus, getComposerMaxHeight]);

  const handleComposerResizeMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const resizeStart = resizeStartRef.current;
    if (!resizeStart || resizeStart.pointerId !== event.pointerId) return;
    resizeStart.pendingY = event.clientY;
    if (resizeStart.frame === null) {
      resizeStart.frame = requestAnimationFrame(applyPendingComposerResize);
    }
  }, [applyPendingComposerResize]);

  const handleComposerResizeEnd = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    finishComposerResize(event.currentTarget, event.pointerId);
  }, [finishComposerResize]);

  const handleComposerResizeKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const maxHeight = getComposerMaxHeight();
    const currentHeight = inputShellRef.current?.getBoundingClientRect().height
      ?? composerHeight
      ?? CHAT_INPUT_DEFAULT_HEIGHT;
    const nextHeight = resolveChatInputResizeHeight(
      currentHeight,
      0,
      event.key === 'ArrowUp' ? -16 : 16,
      maxHeight,
    );
    setComposerMaxHeight(maxHeight);
    composerDesiredHeightRef.current = nextHeight;
    setComposerHeight(nextHeight);
  }, [composerHeight, getComposerMaxHeight]);

  useEffect(() => {
    const panel = inputShellRef.current?.closest<HTMLElement>('[data-section="ai-chat-panel"]');
    if (!panel || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => {
      const maxHeight = resolveVisibleChatInputMaxHeight(panel.clientHeight);
      if (maxHeight == null) return;
      setComposerMaxHeight(maxHeight);
      setComposerHeight(resolveVisibleChatInputHeight(
        composerDesiredHeightRef.current,
        maxHeight,
      ));
    });
    observer.observe(panel);
    return () => observer.disconnect();
  }, []);

  useEffect(() => () => {
    const resizeStart = resizeStartRef.current;
    if (!resizeStart) return;
    if (resizeStart.frame !== null) cancelAnimationFrame(resizeStart.frame);
    document.body.style.userSelect = resizeStart.previousUserSelect;
  }, []);

  const findSlashTrigger = useCallback((text: string, caretPosition: number) => {
    const beforeCaret = text.slice(0, caretPosition);
    const match = /(^|\s)\/([a-z0-9-]*)$/i.exec(beforeCaret);
    if (!match) return null;
    const start = beforeCaret.length - match[0].length + match[1].length;
    return {
      start,
      end: beforeCaret.length,
      query: String(match[2] || '').toLowerCase(),
    };
  }, []);

  const getInputPanelMenuPos = useCallback(() => {
    const rect = inputShellRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const horizontalMargin = 12;
    const safeRight = window.innerWidth - horizontalMargin;
    const width = Math.min(rect.width, safeRight - rect.left);
    return {
      left: rect.left,
      bottom: window.innerHeight - rect.top + 8,
      width,
    };
  }, []);

  const handleInputChange = useCallback((newValue: string) => {
    onChange(newValue);
    const caretPosition = textareaRef.current?.selectionStart ?? newValue.length;
    // Detect if user just typed @
    if (
      hosts.length > 0 &&
      newValue.length > value.length &&
      newValue.endsWith('@')
    ) {
      // Position the popover near the textarea
      const pos = getInputPanelMenuPos();
      if (pos) setInputPanelPos(pos);
      setActiveMenu('atMention');
      return;
    }

    const slashTrigger = findSlashTrigger(newValue, caretPosition);
    if (slashTrigger) {
      const pos = getInputPanelMenuPos();
      if (pos) {
        setMenuPos(null);
        setInputPanelPos(pos);
      }
      setSlashQuery(slashTrigger.query);
      setSlashRange({ start: slashTrigger.start, end: slashTrigger.end });
      setActiveMenu('slashCommand');
      return;
    }

    if (showAtMention && !newValue.includes('@')) {
      setActiveMenu(null);
    } else if (showSlashCommandPicker) {
      closeAllMenus();
    }
  }, [onChange, value, hosts.length, showAtMention, findSlashTrigger, showSlashCommandPicker, closeAllMenus, getInputPanelMenuPos]);

  const handleSelectAtMention = useCallback((host: { label: string; hostname: string }) => {
    // Replace the trailing @ with @hostname
    const name = host.label || host.hostname;
    const lastAt = value.lastIndexOf('@');
    const newValue = lastAt >= 0
      ? value.slice(0, lastAt) + `@${name} `
      : value + `@${name} `;
    onChange(newValue);
    closeAllMenus();
  }, [value, onChange, closeAllMenus]);

  const openInputPanelMenu = useCallback((menu: 'atMention' | 'slashCommand') => {
    const pos = getInputPanelMenuPos();
    if (!pos) return;
    setMenuPos(null);
    setInputPanelPos(pos);
    if (menu === 'slashCommand') {
      const caret = textareaRef.current?.selectionStart ?? value.length;
      const trigger = findSlashTrigger(value, caret);
      if (trigger) {
        setSlashQuery(trigger.query);
        setSlashRange({ start: trigger.start, end: trigger.end });
      } else {
        setSlashQuery('');
        setSlashRange(null);
      }
    }
    setActiveMenu(menu);
  }, [findSlashTrigger, getInputPanelMenuPos, value]);

  const userSkillOptions = useMemo<UserSkillSlashOption[]>(
    () => (lockTurnConfiguration ? [] : userSkills).map((skill) => ({
      id: skill.id,
      slug: skill.slug,
      name: skill.name,
      description: skill.description,
    })),
    [lockTurnConfiguration, userSkills],
  );

  useEffect(() => {
    if (lockTurnConfiguration && (showModelPicker || showPermPicker)) closeAllMenus();
  }, [closeAllMenus, lockTurnConfiguration, showModelPicker, showPermPicker]);

  const quickMessageSlugSet = useMemo(
    () => new Set(quickMessages.map((message) => message.slug)),
    [quickMessages],
  );
  const systemCommandSlugSet = useMemo(
    () => new Set<string>(SYSTEM_BUILTIN_SLASH_COMMANDS.map((command) => command.slug)),
    [],
  );

  const filteredQuickMessages = useMemo(
    () => filterQuickMessages(quickMessages, slashQuery)
      .filter((message) => !systemCommandSlugSet.has(message.slug)),
    [quickMessages, slashQuery, systemCommandSlugSet],
  );

  const availableSystemCommands = useMemo(
    () => SYSTEM_BUILTIN_SLASH_COMMANDS.filter((command) => (
      command.slug !== 'compact' || canCompact
    )),
    [canCompact],
  );

  const filteredSystemCommands = useMemo(
    () => filterSystemSlashCommands(availableSystemCommands, slashQuery),
    [availableSystemCommands, slashQuery],
  );

  const filteredUserSkills = useMemo(
    () => filterUserSkillsForSlash(userSkillOptions, slashQuery)
      .filter((skill) => (
        !quickMessageSlugSet.has(skill.slug)
        && !systemCommandSlugSet.has(skill.slug)
      )),
    [userSkillOptions, slashQuery, quickMessageSlugSet, systemCommandSlugSet],
  );

  const slashCommandItems = useMemo(
    () => buildSlashCommandItems(quickMessages, userSkillOptions, slashQuery, true)
      .filter((item) => item.kind !== 'system' || item.command.slug !== 'compact' || canCompact),
    [quickMessages, userSkillOptions, slashQuery, canCompact],
  );

  const isSlashCatalogEmpty = quickMessages.length === 0 && userSkills.length === 0 && filteredSystemCommands.length === 0;
  const slashPickerNoResultsLabel = isSlashCatalogEmpty
    ? t('ai.chat.slashEmptyHint')
    : t('ai.chat.slashNoResults');
  const slashPickerListboxId = menuPos ? 'slash-command-toolbar' : 'slash-command-input';
  const showSlashPickerUI = showSlashCommandPicker && (inputPanelPos != null || menuPos != null);

  const removeSlashQueryFromInput = useCallback(() => {
    if (!slashRange) return value;
    const before = value.slice(0, slashRange.start);
    const after = value.slice(slashRange.end);
    if (/\s$/.test(before) && /^\s/.test(after)) {
      return `${before}${after.slice(1)}`;
    }
    return `${before}${after}`;
  }, [slashRange, value]);

  const insertUserSkillToken = useCallback((skill: { slug: string }) => {
    if (lockTurnConfiguration) return;
    onAddUserSkill?.(skill.slug);
    if (slashRange) {
      onChange(removeSlashQueryFromInput());
    }
    closeAllMenus();
  }, [closeAllMenus, lockTurnConfiguration, onAddUserSkill, onChange, removeSlashQueryFromInput, slashRange]);

  const insertQuickMessage = useCallback((message: AIQuickMessage) => {
    if (slashRange) {
      const before = value.slice(0, slashRange.start);
      const after = value.slice(slashRange.end);
      const spacerBefore = before.length > 0 && !/\s$/.test(before) ? ' ' : '';
      const spacerAfter = after.length > 0 && !/^\s/.test(after) ? ' ' : '';
      onChange(`${before}${spacerBefore}${message.content}${spacerAfter}${after}`);
    } else {
      const spacer = value.length > 0 && !/\s$/.test(value) ? ' ' : '';
      onChange(`${value}${spacer}${message.content}`);
    }
    closeAllMenus();
  }, [closeAllMenus, onChange, slashRange, value]);

  const handleSelectSlashCommandItem = useCallback((item: SlashCommandItem) => {
    if (item.kind === 'system') {
      const command = item.command.slug;
      if (command === 'compact') {
        if (!canCompact) {
          closeAllMenus();
          return;
        }
        onCompact?.();
      }
      if (command === 'stop') onStop?.();
      onChange('');
      closeAllMenus();
      return;
    }
    if (item.kind === 'quickMessage') {
      insertQuickMessage(item.message);
      return;
    }
    insertUserSkillToken(item.skill);
  }, [canCompact, closeAllMenus, insertQuickMessage, insertUserSkillToken, onChange, onCompact, onStop]);

  // Reset active highlight when a menu opens or when the *identity* of the
  // visible items changes. Watching only `.length` misses cases where the
  // filter produces a different set with the same count (e.g. user types
  // another character into the slash query) — Enter would then commit an
  // unexpected item. Derive a stable key from the visible ids instead.
  const atMentionKey = useMemo(
    () => hosts.map((h) => h.sessionId).join('|'),
    [hosts],
  );
  const slashCommandKey = useMemo(
    () => slashCommandItems.map(getSlashCommandItemKey).join('|'),
    [slashCommandItems],
  );
  useEffect(() => {
    if (showAtMention) setActiveMenuIndex(0);
  }, [showAtMention, atMentionKey]);
  useEffect(() => {
    if (!showAtMention || hosts.length === 0) return;
    atMentionListRef.current?.scrollToIndex(activeMenuIndex);
  }, [activeMenuIndex, atMentionKey, hosts.length, showAtMention]);
  useEffect(() => {
    if (showSlashCommandPicker) setActiveMenuIndex(0);
  }, [showSlashCommandPicker, slashCommandKey]);

  useEffect(() => {
    if (!showSlashCommandPicker || !menuPos || slashCommandItems.length === 0) return;
    slashPickerListRef.current?.focus();
  }, [showSlashCommandPicker, menuPos, slashCommandKey, slashCommandItems.length]);

  const handleSlashCommandKeyDown = useCallback((e: KeyboardEvent | React.KeyboardEvent) => {
    if ('nativeEvent' in e && e.nativeEvent.isComposing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closeAllMenus();
      return;
    }
    if (e.key === 'Enter') {
      if ('shiftKey' in e && e.shiftKey) {
        return;
      }
      if (slashCommandItems.length > 0) {
        e.preventDefault();
        const item = slashCommandItems[Math.min(activeMenuIndex, slashCommandItems.length - 1)];
        if (item) handleSelectSlashCommandItem(item);
        return;
      }
      // Mid-slash token with no matches: block accidental send of "/query" text.
      if (slashRange) {
        e.preventDefault();
      }
      return;
    }
    if (slashCommandItems.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveMenuIndex((i) => (i + 1) % slashCommandItems.length);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveMenuIndex((i) => (i - 1 + slashCommandItems.length) % slashCommandItems.length);
      return;
    }
  }, [activeMenuIndex, closeAllMenus, handleSelectSlashCommandItem, slashCommandItems, slashRange]);

  useEffect(() => {
    if (!showSlashCommandPicker || !menuPos) return;
    const onKeyDown = (event: KeyboardEvent) => handleSlashCommandKeyDown(event);
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [handleSlashCommandKeyDown, menuPos, showSlashCommandPicker]);

  const handleTextareaKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    // @ mention popover keyboard navigation
    if (showAtMention && hosts.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveMenuIndex((i) => (i + 1) % hosts.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveMenuIndex((i) => (i - 1 + hosts.length) % hosts.length);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const host = hosts[Math.min(activeMenuIndex, hosts.length - 1)];
        if (host) handleSelectAtMention(host);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeAllMenus();
        return;
      }
    }
    // / command popover keyboard navigation (input-anchored picker)
    if (showSlashCommandPicker && !menuPos) {
      handleSlashCommandKeyDown(e);
      return;
    }
  }, [showAtMention, hosts, showSlashCommandPicker, menuPos, activeMenuIndex, handleSelectAtMention, handleSlashCommandKeyDown, closeAllMenus]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    if (composerDisabled) return;
    const pastedFiles = Array.from(e.clipboardData.items)
      .map((item: DataTransferItem) => item.getAsFile())
      .filter((f): f is File => !!f);
    if (pastedFiles.length > 0) {
      e.preventDefault();
      onAddFiles?.(pastedFiles);
    }
  }, [composerDisabled, onAddFiles]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (composerDisabled) return;
    const droppedFiles = Array.from(e.dataTransfer.files);
    if (droppedFiles.length > 0) {
      onAddFiles?.(droppedFiles);
    }
  }, [composerDisabled, onAddFiles]);

  const defaultPlaceholder = agentName
    ? t('ai.chat.placeholder').replace('{agent}', agentName)
    : t('ai.chat.placeholderDefault');

  const handleSubmit = useCallback(
    (_text: string, _event: FormEvent<HTMLFormElement>) => {
      const systemCommand = getSystemSlashCommand(value);
      if (systemCommand) {
        if (systemCommand === 'compact') {
          if (!canCompact) return;
          onCompact?.();
          onChange('');
          return;
        }
        if (systemCommand === 'stop') {
          onStop?.();
          onChange('');
          return;
        }
        return;
      }
      if (isStreaming && canSteer) {
        onSteer?.();
        return;
      }
      onSend();
    },
    [canCompact, canSteer, isStreaming, onCompact, onSend, onSteer, onStop, onChange, value],
  );

  const status: PromptInputStatus = isStreaming ? 'streaming' : 'idle';

  // Permission mode chip removed — agents run in auto mode

  // selectedModelId may be "<modelId>/<thinkingLevel>" for codex ChatGPT models
  // (e.g. "gpt-5.4/high"). Note: custom config.toml / OpenRouter model ids
  // themselves can contain '/' (e.g. "qwen/qwen3.6-plus"), so don't just
  // split on the first '/'. Match against the full id first; only treat the
  // trailing segment as a thinking level when we find a preset whose
  // declared thinkingLevels make the combined form equal to selectedModelId.
  const { selectedPreset, selectedThinking } = (() => {
    if (!selectedModelId) return { selectedPreset: undefined, selectedThinking: undefined };
    const direct = modelPresets.find(m => m.id === selectedModelId);
    if (direct) return { selectedPreset: direct, selectedThinking: undefined };
    const viaThinking = modelPresets.find(
      m => m.thinkingLevels?.some(level => `${m.id}/${level}` === selectedModelId),
    );
    if (viaThinking) {
      const thinking = selectedModelId.slice(viaThinking.id.length + 1);
      return { selectedPreset: viaThinking, selectedThinking: thinking };
    }
    return { selectedPreset: undefined, selectedThinking: undefined };
  })();
  const selectedBaseModelId = selectedPreset?.id;
  // Provider switcher mode (Catty Agent): two-column popover, chip carries
  // the provider's icon + name + model name. Falls back to the existing
  // single-list model dropdown for external SDK agents.
  const hasProviderSwitcher = !!providerSwitcher && providerSwitcher.providers.length > 0;
  // Resolve to the actually-bound provider only — no `?? providers[0]`
  // fallback, since a provider that isn't really bound will still hit the
  // `!sendActiveProvider` guard at send time. Faking a selection in the
  // chip would lie about a state the rest of the system treats as empty.
  const selectedSwitcherProvider = hasProviderSwitcher
    ? providerSwitcher!.providers.find((p) => p.id === providerSwitcher!.selectedProviderId)
    : undefined;
  const providerSwitcherChipLabel = hasProviderSwitcher
    ? (selectedSwitcherProvider
        ? (providerSwitcher!.selectedModelId
            ? `${selectedSwitcherProvider.name} · ${providerSwitcher!.selectedModelId}`
            : selectedSwitcherProvider.name)
        : t('ai.chat.selectProvider'))
    : '';
  const modelLabel = hasProviderSwitcher
    ? providerSwitcherChipLabel
    : (selectedPreset
        ? selectedPreset.name + (selectedThinking ? ` / ${formatThinkingLabel(selectedThinking)}` : '')
        : modelName || providerName || t('ai.chat.noModel'));
  const modelChipMaxWidth = hasProviderSwitcher
    ? 'max-w-[180px]'
    : (selectedThinking ? 'max-w-[148px]' : 'max-w-[82px]');
  const hasModelPicker = hasProviderSwitcher || (modelPresets.length > 0 && !!onModelSelect);
  const contextUsagePercent = contextUsage
    ? Math.min(100, Math.max(0, (contextUsage.inputTokens / contextUsage.contextWindow) * 100))
    : 0;
  const contextUsageRingColor = contextUsagePercent >= 80
    ? 'stroke-red-400'
    : contextUsagePercent >= 50
      ? 'stroke-amber-400'
      : 'stroke-emerald-400';
  const contextUsageRingOffset = CONTEXT_USAGE_RING_CIRCUMFERENCE
    * (1 - contextUsagePercent / 100);
  const contextUsageLabel = contextUsage
    ? `${contextUsage.estimated ? '~' : ''}${t('ai.chat.contextUsage')}`
      .replace('{used}', formatContextTokens(contextUsage.inputTokens))
      .replace('{max}', formatContextTokens(contextUsage.contextWindow))
    : '';
  const popoverMaxWidth = hasProviderSwitcher ? PROVIDER_PICKER_MAX_WIDTH : MODEL_PICKER_MAX_WIDTH;
  const chipClassName =
    'inline-flex h-6 items-center gap-1 rounded-full px-1.5 text-[10.5px] text-foreground/72';
  const selectedSkillChipClassName =
    'inline-flex h-7 items-center gap-1.5 rounded-full border border-primary/18 bg-primary/8 pl-2.5 pr-1.5 text-[11px] font-medium text-foreground/86 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]';
  const iconButtonClassName =
    'h-6 w-6 shrink-0 rounded-full bg-transparent text-foreground/62 hover:bg-muted/24 hover:text-foreground';

  return (
    <div className="shrink-0 px-4 pb-4">
      <div
        ref={inputShellRef}
        className="relative"
        style={composerHeight == null ? undefined : { height: composerHeight }}
      >
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label={t('ai.chat.resizeInput')}
        aria-valuemin={CHAT_INPUT_MIN_HEIGHT}
        aria-valuemax={composerMaxHeight}
        aria-valuenow={Math.round(resolveChatInputAriaHeight(
          composerHeight,
          composerMaxHeight,
        ))}
        tabIndex={0}
        title={t('ai.chat.resizeInput')}
        onPointerDown={handleComposerResizeStart}
        onPointerMove={handleComposerResizeMove}
        onPointerUp={handleComposerResizeEnd}
        onPointerCancel={handleComposerResizeEnd}
        onLostPointerCapture={handleComposerResizeEnd}
        onKeyDown={handleComposerResizeKeyDown}
        onDoubleClick={() => {
          composerDesiredHeightRef.current = null;
          setComposerHeight(null);
        }}
        className="group/resize absolute inset-x-2 -top-1 z-20 flex h-2 cursor-ns-resize touch-none items-start justify-center outline-none"
      >
        <span className="mt-[3px] h-0.5 w-10 rounded-full bg-border opacity-0 transition-opacity group-hover/resize:opacity-80 group-focus-visible/resize:opacity-80" />
      </div>
      <PromptInput
        onSubmit={handleSubmit}
        allowEmptySubmit={hasTerminalSelectionAttachment}
        className={composerHeight == null ? undefined : 'h-full'}
        inputGroupClassName={composerHeight == null ? undefined : 'h-full'}
      >
        {/* File attachment chips */}
        {files.length > 0 && (
          <div className="flex gap-1.5 px-3 pt-2 pb-0.5 flex-wrap">
            {files.map((file) => (
              <div
                key={file.id}
                className={[
                  "inline-flex items-center gap-1 pl-1.5 pr-1 rounded-md bg-muted/30 border border-border/30 text-[11px] text-foreground/70 group",
                  file.terminalSelection ? "h-6 max-w-[260px]" : "h-6",
                ].join(" ")}
              >
                {file.terminalSelection ? (
                  <SquareTerminal size={12} className="text-muted-foreground/70 shrink-0" />
                ) : file.mediaType.startsWith('image/') ? (
                  <ImageIcon size={11} className="text-muted-foreground/60 shrink-0" />
                ) : (
                  <FileText size={11} className="text-muted-foreground/60 shrink-0" />
                )}
                {file.terminalSelection ? (
                  <span className="min-w-0">
                    <span className="block truncate max-w-[210px] text-foreground/82">
                      {t('ai.chat.terminalSelectionAttachment')}
                      {file.lineCount ? ` · ${t('ai.chat.terminalSelectionLines').replace('{count}', String(file.lineCount))}` : ''}
                    </span>
                  </span>
                ) : (
                  <span className="truncate max-w-[80px]">{file.filename}</span>
                )}
                <button
                  type="button"
                  onClick={() => onRemoveFile?.(file.id)}
                  disabled={composerDisabled}
                  className="h-3.5 w-3.5 rounded-sm flex items-center justify-center opacity-50 hover:opacity-100 hover:bg-muted/50 transition-opacity cursor-pointer shrink-0"
                >
                  <X size={8} />
                </button>
              </div>
            ))}
          </div>
        )}
        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) {
              onAddFiles?.(Array.from(e.target.files));
              e.target.value = '';
            }
          }}
        />

        {/* Resizable textarea */}
        <div
          data-section="ai-chat-input-body"
          className={[
            'relative',
            composerHeight != null ? 'flex min-h-0 flex-1 flex-col' : undefined,
          ].filter(Boolean).join(' ')}
          onPaste={handlePaste}
          onDrop={handleDrop}
          onDragOver={(e) => e.preventDefault()}
        >
          {selectedUserSkills.length > 0 && (
            <div className="px-3 pt-3 pb-1.5">
              <div className="flex flex-wrap gap-2">
                {selectedUserSkills.map((skill) => (
                  <Tooltip key={skill.id}>
                    <TooltipTrigger asChild>
                      <div
                        className={selectedSkillChipClassName}
                      >
                        <Package size={11} className="text-primary/72 shrink-0" />
                        <span className="truncate max-w-[180px]">
                          {skill.name && skill.name !== skill.slug ? skill.name : `/${skill.slug}`}
                        </span>
                        <button
                          type="button"
                          onClick={() => onRemoveUserSkill?.(skill.slug)}
                          disabled={lockTurnConfiguration}
                          className="inline-flex h-4.5 w-4.5 items-center justify-center rounded-full text-foreground/42 hover:bg-primary/10 hover:text-foreground/72 transition-colors cursor-pointer"
                          aria-label={`Remove skill ${skill.name || skill.slug}`}
                        >
                          <X size={9} />
                        </button>
                      </div>
                    </TooltipTrigger>
                    <TooltipContent>{skill.description || skill.name || skill.slug}</TooltipContent>
                  </Tooltip>
                ))}
              </div>
            </div>
          )}
          <PromptInputTextarea
            ref={textareaRef}
            value={value}
            onChange={(e) => handleInputChange(e.target.value)}
            onKeyDown={handleTextareaKeyDown}
            placeholder={placeholder || (isStreaming && canSteer ? t('ai.codex.steer.placeholder') : defaultPlaceholder)}
            disabled={composerDisabled}
            className={[
              selectedUserSkills.length > 0 ? 'pt-1.5' : undefined,
              composerHeight != null ? 'min-h-0 max-h-none flex-1' : undefined,
            ].filter(Boolean).join(' ')}
            maxLength={100000}
          />
        </div>

        {/* @ mention popover */}
        {showAtMention && hosts.length > 0 && inputPanelPos && createPortal(
          <>
            <div className="fixed inset-0 z-[999]" onClick={closeAllMenus} />
            <div
              role="listbox"
              aria-label="Mention host"
              aria-activedescendant={hosts[activeMenuIndex] ? `at-mention-${hosts[activeMenuIndex].sessionId}` : undefined}
              className="fixed z-[1000] overflow-hidden rounded-lg border border-border/50 bg-popover shadow-lg"
              style={{ left: inputPanelPos.left, bottom: inputPanelPos.bottom, width: 'auto', minWidth: Math.min(200, inputPanelPos.width), maxWidth: inputPanelPos.width }}
            >
              <div className="max-h-[280px]" style={{ height: Math.min(280, 8 + hosts.reduce((total, host) => total + (host.label
                && host.hostname !== host.label
                && !host.label.includes(host.hostname) ? 52 : 36), 0)) }}>
                <VariableSizeVirtualList
                  ref={atMentionListRef}
                  items={hosts}
                  getItemHeight={(host) => host.label
                    && host.hostname !== host.label
                    && !host.label.includes(host.hostname) ? 52 : 36}
                  getItemKey={(host) => host.sessionId}
                  className="h-full"
                  contentClassName="p-1"
                  renderItem={(host, idx) => {
                  const isActive = idx === activeMenuIndex;
                  const showHostnameLine = host.label
                    && host.hostname !== host.label
                    && !host.label.includes(host.hostname);
                  return (
                    <button
                      id={`at-mention-${host.sessionId}`}
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      onMouseEnter={() => setActiveMenuIndex(idx)}
                      onClick={() => handleSelectAtMention(host)}
                      className={`h-full w-full rounded-md px-2 py-1 text-left transition-colors cursor-pointer ${isActive ? 'bg-muted/40' : 'hover:bg-muted/30'}`}
                    >
                      <div className="flex items-center gap-2 text-[12px] text-foreground/90">
                        <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${host.connected ? 'bg-green-500' : 'bg-muted-foreground/30'}`} />
                        <span className="truncate">{host.label || host.hostname}</span>
                      </div>
                      {showHostnameLine ? (
                        <div className="pl-3.5 text-[10px] text-muted-foreground/60 truncate">
                          {host.hostname}
                        </div>
                      ) : null}
                    </button>
                  );
                  }}
                />
              </div>
            </div>
          </>,
          document.body,
        )}

        {/* / command popover */}
        {showSlashPickerUI && createPortal(
          <>
            <div className="fixed inset-0 z-[999]" onClick={closeAllMenus} />
            <SlashCommandPicker
              listRef={slashPickerListRef}
              listboxId={slashPickerListboxId}
              ariaLabel={t('ai.chat.slashCommands')}
              systemCommands={filteredSystemCommands}
              quickMessages={filteredQuickMessages}
              userSkills={filteredUserSkills}
              slashCommandItems={slashCommandItems}
              activeMenuIndex={activeMenuIndex}
              onActiveIndexChange={setActiveMenuIndex}
              onSelectQuickMessage={insertQuickMessage}
              onSelectSystemCommand={(command) => handleSelectSlashCommandItem({ kind: 'system', command })}
              onSelectSkill={insertUserSkillToken}
              systemCommandsSectionLabel={t('ai.chat.slashSystemCommands')}
              systemCommandDescription={(command) => t(command.descriptionKey)}
              quickMessagesSectionLabel={t('ai.chat.slashQuickMessages')}
              userSkillsSectionLabel={t('ai.chat.slashUserSkills')}
              noResultsLabel={slashPickerNoResultsLabel}
              className="fixed z-[1000] overflow-hidden rounded-lg border border-border/50 bg-popover shadow-lg outline-none"
              style={
                menuPos
                  ? {
                      left: menuPos.left,
                      bottom: menuPos.bottom,
                      minWidth: 220,
                      maxWidth: 360,
                    }
                  : {
                      left: inputPanelPos!.left,
                      bottom: inputPanelPos!.bottom,
                      width: 'auto',
                      minWidth: Math.min(200, inputPanelPos!.width),
                      maxWidth: inputPanelPos!.width,
                    }
              }
            />
          </>,
          document.body,
        )}

        {/* Footer toolbar */}
        <PromptInputFooter
          data-section="ai-chat-input-footer"
          className="shrink-0 gap-1.5 border-t-0 bg-transparent px-3 pb-2 pt-0"
        >
          <PromptInputTools className="gap-1 min-w-0">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  ref={attachBtnRef}
                  type="button"
                  disabled={composerDisabled}
                  onClick={() => {
                    if (!showAttachMenu) {
                      const rect = attachBtnRef.current?.getBoundingClientRect();
                      if (rect) setMenuPos({ left: rect.left, bottom: window.innerHeight - rect.top + 6 });
                      setActiveMenu('attach');
                    } else {
                      closeAllMenus();
                    }
                  }}
                  className={iconButtonClassName}
                  aria-label={t('ai.chat.attach')}
                  aria-expanded={showAttachMenu}
                >
                  <Plus size={13} />
                </button>
              </TooltipTrigger>
              <TooltipContent>{t('ai.chat.attach')}</TooltipContent>
            </Tooltip>
            {showAttachMenu && menuPos && createPortal(
              <>
                <div className="fixed inset-0 z-[999]" onClick={closeAllMenus} />
                <div className="fixed inset-0 z-[999] cursor-default" onClick={closeAllMenus} />
                <div
                  role="menu"
                  className="fixed z-[1000] min-w-[170px] rounded-lg border border-border/50 bg-popover shadow-lg py-1"
                  style={{ left: menuPos.left, bottom: menuPos.bottom }}
                >
                  <div className="px-3 py-1 text-[10px] text-muted-foreground/40 tracking-wide">{t('ai.chat.menuContext')}</div>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => { fileInputRef.current?.setAttribute('accept', '*/*'); fileInputRef.current?.click(); closeAllMenus(); }}
                    className="w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-[12px] hover:bg-muted/30 transition-colors cursor-pointer whitespace-nowrap"
                  >
                    <FileText size={13} className="text-muted-foreground/60" />
                    <span className="text-foreground/85">{t('ai.chat.menuFiles')}</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => { fileInputRef.current?.setAttribute('accept', 'image/*'); fileInputRef.current?.click(); closeAllMenus(); }}
                    className="w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-[12px] hover:bg-muted/30 transition-colors cursor-pointer whitespace-nowrap"
                  >
                    <ImageIcon size={13} className="text-muted-foreground/60" />
                    <span className="text-foreground/85">{t('ai.chat.menuImage')}</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    aria-label="Mention host"
                    onClick={() => openInputPanelMenu('atMention')}
                    className="w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-[12px] hover:bg-muted/30 transition-colors cursor-pointer whitespace-nowrap"
                  >
                    <AtSign size={13} className="text-muted-foreground/60" />
                    <span className="flex-1 text-foreground/85">{t('ai.chat.menuMentionHost')}</span>
                    {hosts.length > 0 && <ChevronRight size={10} className="text-muted-foreground/50" />}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    aria-label={t('ai.chat.slashCommands')}
                    onClick={() => openInputPanelMenu('slashCommand')}
                    className="w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-[12px] hover:bg-muted/30 transition-colors cursor-pointer whitespace-nowrap"
                  >
                    <MessageSquare size={13} className="text-muted-foreground/60" />
                    <span className="flex-1 text-foreground/85">{t('ai.chat.menuSlashCommands')}</span>
                    <ChevronRight size={10} className="text-muted-foreground/50" />
                  </button>
                </div>
              </>,
              document.body,
            )}
            <button
              ref={modelBtnRef}
              type="button"
              onClick={() => {
                if (!hasModelPicker || lockTurnConfiguration) return;
                if (!showModelPicker) {
                  const rect = modelBtnRef.current?.getBoundingClientRect();
                  if (rect) {
                    // Clamp so the popover stays inside the viewport when
                    // the chip is near the right edge of a narrow AI side
                    // panel.
                    const left = Math.max(8, Math.min(rect.left, window.innerWidth - popoverMaxWidth - 8));
                    setMenuPos({ left, bottom: window.innerHeight - rect.top + 6 });
                  }
                  if (selectedPreset?.thinkingLevels?.length) {
                    setHoveredModelId(selectedPreset.id);
                  }
                  setActiveMenu('model');
                } else {
                  closeAllMenus();
                }
              }}
              disabled={lockTurnConfiguration}
              className={`${chipClassName} min-w-0 ${hasModelPicker && !lockTurnConfiguration ? 'cursor-pointer hover:bg-muted/24 transition-colors' : 'opacity-60'}`}
              aria-label={hasProviderSwitcher ? 'Select provider and model' : 'Select model'}
              aria-expanded={showModelPicker}
            >
              {hasProviderSwitcher && selectedSwitcherProvider ? (
                <ProviderIconBadge provider={selectedSwitcherProvider} size="xs" />
              ) : (
                <Cpu size={11} className="text-muted-foreground/64" />
              )}
              <span className={`truncate min-w-0 ${modelChipMaxWidth}`}>{modelLabel}</span>
              {hasModelPicker && <ChevronDown size={9} className="text-muted-foreground/50" />}
            </button>
            {contextUsage && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <div
                    role="progressbar"
                    aria-label={contextUsageLabel}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(contextUsagePercent)}
                    className="relative flex h-4 w-4 shrink-0 items-center justify-center"
                  >
                    <svg
                      aria-hidden="true"
                      className="h-4 w-4"
                      viewBox="0 0 28 28"
                    >
                      <circle
                        className="stroke-muted/40"
                        cx="14"
                        cy="14"
                        fill="none"
                        r={CONTEXT_USAGE_RING_RADIUS}
                        strokeWidth="3.5"
                      />
                      <circle
                        className={`${contextUsageRingColor} transition-[stroke-dashoffset] duration-300`}
                        cx="14"
                        cy="14"
                        fill="none"
                        r={CONTEXT_USAGE_RING_RADIUS}
                        strokeDasharray={CONTEXT_USAGE_RING_CIRCUMFERENCE}
                        strokeDashoffset={contextUsageRingOffset}
                        strokeLinecap="round"
                        strokeWidth="3.5"
                        transform="rotate(-90 14 14)"
                      />
                    </svg>
                  </div>
                </TooltipTrigger>
                <TooltipContent>{contextUsageLabel}</TooltipContent>
              </Tooltip>
            )}
            {showModelPicker && hasModelPicker && menuPos && createPortal(
<>
            <div className="fixed inset-0 z-[999]" onClick={closeAllMenus} />
            <div className="fixed inset-0 z-[999] cursor-default" onClick={closeAllMenus} />
            <div
              role="listbox"
                  aria-label={hasProviderSwitcher ? 'Select provider and model' : 'Select model'}
                  className="fixed z-[1000] w-max min-w-[160px] rounded-lg border border-border/50 bg-popover shadow-lg py-1"
                  style={{ left: menuPos.left, bottom: menuPos.bottom, maxWidth: popoverMaxWidth }}
                  onMouseLeave={() => setHoveredModelId(null)}
                >
                  {hasProviderSwitcher ? (
                    <div className="min-w-[260px] max-h-[320px] overflow-y-auto">
                      {providerSwitcher!.providers.map((p) => {
                        const isSelected = providerSwitcher!.selectedProviderId === p.id;
                        const defaultModel = p.defaultModel?.trim() ?? '';
                        const hasModel = defaultModel.length > 0;
                        // Rows without a defaultModel are inert — picking
                        // one would save a binding with an empty model id
                        // and produce a confusing model error at send time.
                        // User has to set a defaultModel in Settings first.
                        const disabled = !hasModel;
                        const modelCaption = hasModel
                          ? defaultModel
                          : t('ai.chat.noProviderModel');
                        return (
                          <button
                            key={p.id}
                            type="button"
                            role="option"
                            aria-selected={isSelected}
                            aria-disabled={disabled}
                            disabled={disabled}
                            title={disabled ? t('ai.chat.noProviderModel') : undefined}
                            onClick={() => {
                              if (disabled) return;
                              providerSwitcher!.onSelect(p.id, defaultModel);
                              closeAllMenus();
                            }}
                            className={`w-full flex items-center gap-2.5 px-2.5 py-2 text-left transition-colors ${
                              disabled
                                ? 'opacity-55 cursor-not-allowed'
                                : 'hover:bg-muted/30 cursor-pointer'
                            }`}
                          >
                            <ProviderIconBadge provider={p} size="md" />
                            <div className="flex-1 min-w-0">
                              <div className="truncate text-[12px] text-foreground/85">{p.name}</div>
                              <div className={`truncate text-[10.5px] ${hasModel ? 'text-muted-foreground/70 font-mono' : 'text-muted-foreground/55 italic'}`}>
                                {modelCaption}
                              </div>
                            </div>
                            {isSelected && <Check size={12} className="text-primary shrink-0" />}
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="min-w-[260px] max-h-[320px] overflow-y-auto">
                      {modelPresets.map(preset => {
                    const isSelected = preset.id === selectedBaseModelId;
                    const hasThinking = preset.thinkingLevels && preset.thinkingLevels.length > 0;
                    const showThinkingLevels = hasThinking && hoveredModelId === preset.id;
                    return (
                      <div
                        key={preset.id}
                        onMouseEnter={() => setHoveredModelId(hasThinking ? preset.id : null)}
                        onFocus={() => { if (hasThinking) setHoveredModelId(preset.id); }}
                        onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setHoveredModelId(null); }}
                      >
                        <button
                          type="button"
                          role="option"
                          aria-selected={isSelected}
                          aria-expanded={hasThinking ? showThinkingLevels : undefined}
                          onClick={() => {
                            if (!hasThinking) {
                              onModelSelect?.(preset.id);
                              closeAllMenus();
                              return;
                            }
                            setHoveredModelId(showThinkingLevels ? null : preset.id);
                          }}
                          className="w-full min-w-0 flex items-center gap-1.5 px-3 py-1.5 text-left text-[12px] hover:bg-muted/30 transition-colors cursor-pointer"
                        >
                          {isSelected ? <Check size={11} className="text-primary shrink-0" /> : <span className="w-[11px] shrink-0" />}
                          <span className="flex-1 min-w-0 truncate text-foreground/85">{preset.name}</span>
                          {hasThinking && (
                            <ChevronRight
                              size={10}
                              className={`text-muted-foreground/50 shrink-0 transition-transform ${showThinkingLevels ? 'rotate-90' : ''}`}
                            />
                          )}
                        </button>
                        {/* Inline thinking levels — flyout submenus get clipped by overflow-y-auto above. */}
                        {showThinkingLevels && (
                          <div role="listbox" aria-label="Thinking level" className="border-t border-border/30 bg-muted/10 py-0.5">
                            {preset.thinkingLevels!.map(level => {
                              const fullId = `${preset.id}/${level}`;
                              const isLevelSelected = selectedModelId === fullId;
                              return (
                                <button
                                  key={level}
                                  type="button"
                                  role="option"
                                  aria-selected={isLevelSelected}
                                  tabIndex={0}
                                  onClick={() => {
                                    onModelSelect?.(fullId);
                                    closeAllMenus();
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter' || e.key === ' ') {
                                      e.preventDefault();
                                      onModelSelect?.(fullId);
                                      closeAllMenus();
                                    } else if (e.key === 'Escape') {
                                      e.preventDefault();
                                      closeAllMenus();
                                    }
                                  }}
                                  className="w-full flex items-center gap-1.5 pl-7 pr-3 py-1.5 text-left text-[12px] hover:bg-muted/30 transition-colors cursor-pointer whitespace-nowrap"
                                >
                                  {isLevelSelected ? <Check size={11} className="text-primary shrink-0" /> : <span className="w-[11px] shrink-0" />}
                                  <span className="text-foreground/85">{formatThinkingLabel(level)}</span>
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                      })}
                    </div>
                  )}
                </div>
              </>,
              document.body,
            )}
            {/* Permission mode chip — only for Catty Agent */}
            {permissionMode && onPermissionModeChange && (
              <>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      ref={permBtnRef}
                      type="button"
                      disabled={lockTurnConfiguration}
                      onClick={() => {
                        if (lockTurnConfiguration) return;
                        if (!showPermPicker) {
                          const rect = permBtnRef.current?.getBoundingClientRect();
                          if (rect) {
                            const left = Math.max(
                              MENU_VIEWPORT_GUTTER,
                              Math.min(
                                rect.left,
                                window.innerWidth - PERMISSION_PICKER_WIDTH - MENU_VIEWPORT_GUTTER,
                              ),
                            );
                            setMenuPos({ left, bottom: window.innerHeight - rect.top + 6 });
                          }
                          setActiveMenu('perm');
                        } else {
                          closeAllMenus();
                        }
                      }}
                      className={`${chipClassName} shrink-0 cursor-pointer hover:bg-muted/24 transition-colors`}
                      aria-label={t('ai.safety.permissionMode')}
                      aria-expanded={showPermPicker}
                    >
                      {permissionMode === 'observer' && <Eye size={11} className="text-blue-400/70" />}
                      {permissionMode === 'confirm' && <ShieldCheck size={11} className="text-yellow-400/70" />}
                      {permissionMode === 'auto' && <Zap size={11} className="text-green-400/70" />}
                      <span className="truncate max-w-[72px]">
                        {permissionMode === 'observer' && t('ai.chat.permObserver')}
                        {permissionMode === 'confirm' && t('ai.chat.permConfirm')}
                        {permissionMode === 'auto' && t('ai.chat.permAuto')}
                      </span>
                      <ChevronDown size={9} className="text-muted-foreground/50" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>{t('ai.safety.permissionMode')}</TooltipContent>
                </Tooltip>
                {showPermPicker && menuPos && createPortal(
                  <>
                    <div className="fixed inset-0 z-[999]" onClick={closeAllMenus} />
                    <div className="fixed inset-0 z-[999] cursor-default" onClick={closeAllMenus} />
                    <div
                      role="listbox"
                      aria-label="Permission mode"
                      className="fixed z-[1000] w-[250px] max-w-[calc(100vw-16px)] rounded-lg border border-border/50 bg-popover shadow-lg py-1"
                      style={{ left: menuPos.left, bottom: menuPos.bottom }}
                    >
                      {([
                        { mode: 'auto' as const, icon: Zap, color: 'text-green-400/70', label: t('ai.chat.permAuto'), desc: t('ai.chat.permAutoDesc') },
                        { mode: 'confirm' as const, icon: ShieldCheck, color: 'text-yellow-400/70', label: t('ai.chat.permConfirm'), desc: t('ai.chat.permConfirmDesc') },
                        { mode: 'observer' as const, icon: Eye, color: 'text-blue-400/70', label: t('ai.chat.permObserver'), desc: t('ai.chat.permObserverDesc') },
                      ]).map(({ mode, icon: Icon, color, label, desc }) => (
                        <button
                          key={mode}
                          type="button"
                          disabled={lockTurnConfiguration}
                          role="option"
                          aria-selected={permissionMode === mode}
                          onClick={() => {
                            onPermissionModeChange(mode);
                            closeAllMenus();
                          }}
                          className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-muted/30 transition-colors cursor-pointer"
                        >
                          {permissionMode === mode
                            ? <Check size={11} className="text-primary shrink-0" />
                            : <span className="w-[11px] shrink-0" />
                          }
                          <Icon size={12} className={`${color} shrink-0`} />
                          <div className="flex-1 min-w-0">
                            <div className="text-foreground/85">{label}</div>
                            <div className="text-[10px] text-muted-foreground/40 leading-tight">{desc}</div>
                          </div>
                        </button>
                      ))}
                    </div>
                  </>,
                  document.body,
                )}
              </>
            )}
          </PromptInputTools>

          <div className="flex-1 min-w-0" />

          <div className="flex items-center gap-1">
            {isStreaming && canSteer ? (
              <>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="submit"
                      disabled={(!value.trim() && !hasTerminalSelectionAttachment) || composerDisabled}
                      aria-label={isSteering ? t('ai.codex.steer.sending') : t('ai.codex.steer.addInstruction')}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-foreground/20 bg-foreground text-background shadow-sm transition-colors hover:bg-foreground/90 disabled:border-border/80 disabled:bg-muted/52 disabled:text-foreground/72"
                    >
                      {isSteering ? <Loader2 size={14} className="animate-spin" /> : <ArrowUp size={14} />}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>{isSteering ? t('ai.codex.steer.sending') : t('ai.codex.steer.addInstruction')}</TooltipContent>
                </Tooltip>
                <PromptInputSubmit status="streaming" onStop={onStop} />
              </>
            ) : (
              <PromptInputSubmit
                status={status}
                onStop={onStop}
                disabled={(!value.trim() && !hasTerminalSelectionAttachment) || disabled}
              />
            )}
          </div>
        </PromptInputFooter>
      </PromptInput>
      </div>
    </div>
  );
};

export default React.memo(ChatInput);
