import React, { useState } from "react";
import { ChevronDown, Plus } from "lucide-react";
import type { AIProviderId } from "../../../../infrastructure/ai/types";
import { PROVIDER_PRESETS } from "../../../../infrastructure/ai/types";
import { useI18n } from "../../../../application/i18n/I18nProvider";
import { Button } from "../../../ui/button";
import { cn } from "../../../../lib/utils";
import { ProviderIconBadge } from "./ProviderIconBadge";

export const ADD_PROVIDER_MENU_CLASS =
  "absolute top-full right-0 mt-1 z-[101] min-w-[220px] max-w-[calc(100vw-2rem)] rounded-md border border-border bg-popover shadow-md py-1";

export const AddProviderDropdown: React.FC<{
  onAdd: (providerId: AIProviderId) => void;
}> = ({ onAdd }) => {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);

  const providerIds = Object.keys(PROVIDER_PRESETS) as AIProviderId[];

  return (
    <div className="relative">
      <Button
        variant="outline"
        size="sm"
        onClick={() => setIsOpen(!isOpen)}
        className="gap-1.5"
      >
        <Plus size={14} />
        {t('ai.providers.add')}
        <ChevronDown size={12} className={cn("transition-transform", isOpen && "rotate-180")} />
      </Button>

      {isOpen && (
        <>
          {/* Backdrop */}
          <div className="fixed inset-0 z-[100]" onClick={() => setIsOpen(false)} />
          {/* Menu */}
          <div className={ADD_PROVIDER_MENU_CLASS}>
            {providerIds.map((pid) => (
              <button
                key={pid}
                onClick={() => {
                  onAdd(pid);
                  setIsOpen(false);
                }}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground transition-colors text-left"
              >
                <ProviderIconBadge providerId={pid} size="sm" />
                {PROVIDER_PRESETS[pid].name}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
};
