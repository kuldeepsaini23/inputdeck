import { Globe } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '#/components/ui/dropdown-menu'
import { LANGUAGES, isLang, nativeName, setLang, useLang, useT } from '#/lib/i18n'

/** Compact globe + native language name; opens a list of languages by their own names. */
export function LanguagePicker() {
  const lang = useLang()
  const t = useT()
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger aria-label={t('Language')} title={t('Language')}
        className="display flex max-w-[150px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-1 text-[10.5px] font-semibold text-[var(--text-3)] outline-none hover:text-[var(--text)] focus-visible:text-[var(--text)]">
        <Globe className="size-3.5 shrink-0" />
        <span className="truncate" lang={lang}>{nativeName(lang)}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8} className="scroll-thin max-h-[70vh] min-w-[180px] rounded-2xl border-white/10 bg-[#121214]/95 p-1 backdrop-blur-xl">
        <DropdownMenuRadioGroup value={lang} onValueChange={(v) => isLang(v) && setLang(v)}>
          {LANGUAGES.map(([code, name]) => (
            <DropdownMenuRadioItem key={code} value={code} lang={code} className="rounded-lg py-2 text-[13px]">
              {name}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
