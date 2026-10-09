// =============================================================================
// Navegação do header (desktop, md+): uma linha só, sem rolagem e sem quebra.
// Itens de trabalho à vista em pílulas (a ativa segue vermelha, como no handoff);
// o que não couber na largura vai, na mesma ordem, para o topo do menu.
// Gestão e o antigo "Mais" ficam no menu "Gestão" (ou "Mais" para quem não é gestor).
// =============================================================================
import { useLayoutEffect, useRef, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { quantosCabem, rotaAtiva, type ChaveContador, type ItemNav, type Navegacao } from "./navegacao";

type Contagens = Record<ChaveContador, number>;

function Contador({ n, critica, ativo }: { n: number; critica?: boolean; ativo: boolean }) {
  if (!n) return null;
  return (
    <span
      className={cn("min-w-[18px] rounded-full px-1.5 text-center text-[11px] font-semibold leading-[18px] tabular-nums", ativo && "bg-white/20 text-white")}
      style={
        ativo
          ? undefined
          : critica
            ? { background: "var(--signal-soft)", color: "var(--signal-strong)" }
            : { background: "var(--bg-muted)", color: "var(--c-ink-soft)" }
      }
    >
      {n > 999 ? "999+" : n}
    </span>
  );
}

const PILULA =
  "flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-[13px] font-medium outline-none transition-[background-color,color] duration-150 focus-visible:ring-2 focus-visible:ring-[var(--border-focus)] focus-visible:ring-offset-1";

function Pilula({ item, contagens }: { item: ItemNav; contagens: Contagens }) {
  const n = item.contador ? contagens[item.contador] : 0;
  return (
    <NavLink
      to={item.to}
      end={item.to === "/inbox"}
      aria-label={n ? `${item.rotulo}, ${n}` : undefined}
      className={({ isActive }) => cn(PILULA, isActive ? "text-white" : "text-ink-soft-2 hover:bg-subtle hover:text-[var(--c-ink)]")}
      style={({ isActive }) => (isActive ? { background: "var(--signal)", boxShadow: "0 4px 10px rgba(224,49,49,.22)" } : undefined)}
    >
      {({ isActive }) => (
        <>
          {item.rotulo}
          <Contador n={n} critica={item.critica} ativo={isActive} />
        </>
      )}
    </NavLink>
  );
}

export function NavegacaoHeader({ nav, contagens }: { nav: Navegacao; contagens: Contagens }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const caixa = useRef<HTMLDivElement>(null);
  const medida = useRef<HTMLDivElement>(null);
  const medidaMenu = useRef<HTMLSpanElement>(null);
    const [cabem, setCabem] = useState(nav.trabalho.length);

  // Mede as pílulas numa cópia invisível e decide quantas cabem; refaz ao redimensionar.
  const chave = nav.trabalho.map((i) => i.to).join("|") + JSON.stringify(contagens);
  useLayoutEffect(() => {
    const el = caixa.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const calcular = () => {
      const filhos = Array.from(medida.current?.children ?? []) as HTMLElement[];
      const larguras = filhos.map((f) => f.getBoundingClientRect().width);
      // O botão do menu medido já com o maior contador que pode ganhar (evita invadir a direita).
      const menu = (medidaMenu.current?.getBoundingClientRect().width ?? 120) + 8;
      const todasCabem = quantosCabem(larguras, el.clientWidth, nav.menu.length ? menu : 0) === larguras.length;
      setCabem(todasCabem ? larguras.length : quantosCabem(larguras, el.clientWidth, menu));
    };
    calcular();
    const ro = new ResizeObserver(calcular);
    ro.observe(el);
    // A cópia muda de largura quando a fonte web termina de carregar: remede.
    if (medida.current) ro.observe(medida.current);
    document.fonts?.ready.then(calcular).catch(() => {});
    return () => ro.disconnect();
  }, [chave, nav.menu.length]);

  const visiveis = nav.trabalho.slice(0, cabem);
  const sobra = nav.trabalho.slice(cabem);
  const gestao = nav.menu.filter((i) => i.grupo === "gestao");
  const sistema = nav.menu.filter((i) => i.grupo !== "gestao");
  const temMenu = sobra.length + nav.menu.length > 0;
  const menuAtivo = [...sobra, ...nav.menu].some((i) => rotaAtiva(i.to, pathname));
  const rotulo = nav.menu.length ? nav.rotuloMenu : "Mais";
  const totalCritico = nav.trabalho.reduce((s, i) => s + (i.contador && i.critica ? contagens[i.contador] : 0), 0);
  const sobraComContador = sobra.reduce((s, i) => s + (i.contador && i.critica ? contagens[i.contador] : 0), 0);

  const itemMenu = (i: ItemNav) => {
    const ativo = rotaAtiva(i.to, pathname);
    const n = i.contador ? contagens[i.contador] : 0;
    return (
      <DropdownMenuItem
        key={i.to}
        onSelect={() => navigate(i.to)}
        aria-current={ativo ? "page" : undefined}
        className={cn("justify-between gap-3 text-[13px]", ativo && "font-semibold text-[var(--signal-strong)]")}
      >
        {i.rotulo}
        <Contador n={n} critica={i.critica} ativo={false} />
      </DropdownMenuItem>
    );
  };

  return (
    <div ref={caixa} className="relative hidden min-w-0 flex-1 items-center md:flex">
      {/* Cópia invisível só para medir (fora da árvore de acessibilidade). */}
      <div ref={medida} aria-hidden className="pointer-events-none invisible absolute left-0 top-0 flex gap-1" style={{ height: 0, overflow: "hidden" }}>
        {nav.trabalho.map((i) => (
          <span key={i.to} className={cn(PILULA, "text-ink-soft-2")}>
            {i.rotulo}
            <Contador n={i.contador ? contagens[i.contador] : 0} critica={i.critica} ativo={false} />
          </span>
        ))}
      </div>
      <span ref={medidaMenu} aria-hidden className={cn(PILULA, "pointer-events-none invisible absolute gap-1 pr-2.5")} style={{ left: -9999 }}>
        {rotulo}
        <Contador n={totalCritico} critica ativo={false} />
        <ChevronDown className="h-3.5 w-3.5" />
      </span>

      <nav aria-label="Principal" className="flex min-w-0 items-center gap-1">
        {visiveis.map((i) => (
          <Pilula key={i.to} item={i} contagens={contagens} />
        ))}
        {temMenu && (
          <DropdownMenu>
            <DropdownMenuTrigger
              className={cn(PILULA, "gap-1 pr-2.5", menuAtivo ? "bg-subtle text-[var(--c-ink)]" : "text-ink-soft-2 hover:bg-subtle hover:text-[var(--c-ink)]")}
              data-active={menuAtivo || undefined}
              aria-label={menuAtivo ? `${rotulo} (a página atual está neste menu)` : undefined}
            >
              {rotulo}
              {sobraComContador > 0 && <Contador n={sobraComContador} critica ativo={false} />}
              <ChevronDown className="h-3.5 w-3.5 text-ink-mute" aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              {sobra.length > 0 && (
                <DropdownMenuGroup>
                  <DropdownMenuLabel className="text-[11px] font-medium text-muted-foreground">Trabalho</DropdownMenuLabel>
                  {sobra.map(itemMenu)}
                </DropdownMenuGroup>
              )}
              {gestao.length > 0 && (
                <>
                  {sobra.length > 0 && <DropdownMenuSeparator />}
                  <DropdownMenuGroup>
                    <DropdownMenuLabel className="text-[11px] font-medium text-muted-foreground">Gestão</DropdownMenuLabel>
                    {gestao.map(itemMenu)}
                  </DropdownMenuGroup>
                </>
              )}
              {sistema.length > 0 && (
                <>
                  {(sobra.length > 0 || gestao.length > 0) && <DropdownMenuSeparator />}
                  <DropdownMenuGroup>
                    <DropdownMenuLabel className="text-[11px] font-medium text-muted-foreground">Sistema</DropdownMenuLabel>
                    {sistema.map(itemMenu)}
                  </DropdownMenuGroup>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </nav>
    </div>
  );
}
