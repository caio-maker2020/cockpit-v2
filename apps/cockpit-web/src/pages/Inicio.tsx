// =============================================================================
// /inicio — o hub do gestor (pedido do Matheus, 09/10): ao entrar, o gestor
// escolhe a área. Um bloco grande para a área mais urgente agora e um menor para
// a outra, ambos com números ao vivo, mais os atalhos de gestão.
// Só leitura: nada aqui grava, e as telas do Relacionamento não mudam.
// =============================================================================
import { useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  ArrowRight,
  Bot,
  ClipboardCheck,
  Gauge,
  GraduationCap,
  LayoutDashboard,
  RadioTower,
  Users,
  type LucideIcon,
} from "lucide-react";

import { useAuth } from "@/contexts/AuthContext";
import { useAreas } from "@/contexts/OperacaoContext";
import { OPERACAO_DEMO, OPERACAO_DEMO_V3 } from "@/lib/operacao/modoDemo";
import { primeiroNome, saudacao } from "@/lib/format";
import {
  areaDestaque,
  gravarUltimaArea,
  lerUltimaArea,
  prepararAbaOperacao,
  type Area,
} from "@/lib/inicio/hub";
import { useNumerosOperacao, useNumerosRelacionamento, type Numero } from "@/components/inicio/useNumerosHub";
import { cn } from "@/lib/utils";

/** Na demonstração do v3 o Relacionamento é o outro build, servido ao lado. */
const HREF_REL_DEMO = OPERACAO_DEMO_V3 ? "/relacionamento-cockpit/" : null;

interface Stat {
  rotulo: string;
  numero: Numero;
  /** Vermelho quando > 0 (pede o gestor). */
  critico?: boolean;
}

function ValorStat({ n, grande, critico, escuro }: { n: Numero; grande: boolean; critico?: boolean; escuro: boolean }) {
  const tam = grande ? "text-[44px] leading-none md:text-[56px]" : "text-[28px] leading-none";
  if (n.carregando) {
    return (
      <span
        aria-hidden
        className={cn("block animate-pulse rounded-md", grande ? "h-11 w-16 md:h-14" : "h-7 w-10")}
        style={{ background: escuro ? "rgba(255,255,255,.12)" : "var(--bg-muted)" }}
      />
    );
  }
  if (n.erro || n.valor == null) {
    return (
      <span className={cn("font-mono font-semibold tabular-nums", tam)} style={{ color: escuro ? "rgba(255,255,255,.45)" : "var(--c-ink-mute)" }} title="Não deu para ler agora">
        —
      </span>
    );
  }
  const alerta = critico && n.valor > 0;
  return (
    <span
      className={cn("font-mono font-semibold tabular-nums tracking-tight", tam)}
      style={{ color: alerta ? (escuro ? "#FF6B6B" : "var(--signal)") : escuro ? "#fff" : "var(--c-ink)" }}
    >
      {n.valor}
    </span>
  );
}

const textoStat = (s: Stat) =>
  `${s.rotulo}: ${s.numero.carregando ? "carregando" : s.numero.erro || s.numero.valor == null ? "indisponível" : s.numero.valor}`;

function BlocoArea({
  area,
  destaque,
  titulo,
  descricao,
  stats,
  rodape,
  to,
  href,
  atalho,
  cta,
}: {
  area: Area;
  destaque: boolean;
  titulo: string;
  descricao: string;
  stats: Stat[];
  rodape?: React.ReactNode;
  to: string;
  href?: string | null;
  atalho: string;
  cta: string;
}) {
  const escuro = destaque;
  const conteudo = (
    <>
      {destaque && <span aria-hidden className="absolute inset-y-0 left-0 w-1.5" style={{ background: "var(--signal)" }} />}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p
            className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.14em]"
            style={{ color: escuro ? "#FF8A8A" : "var(--c-ink-mute)" }}
          >
            {destaque ? "Mais urgente agora" : "Outra área"}
          </p>
          <h2
            className={cn("mt-1.5 font-semibold tracking-tight", destaque ? "text-[34px] leading-[1.05] md:text-[44px]" : "text-[22px] leading-tight")}
            style={{ color: escuro ? "#fff" : "var(--c-ink)" }}
          >
            {titulo}
          </h2>
          <p className="mt-1.5 max-w-[46ch] text-[13px] leading-snug" style={{ color: escuro ? "rgba(255,255,255,.66)" : "var(--c-ink-soft)" }}>
            {descricao}
          </p>
        </div>
        <kbd
          className="hidden shrink-0 rounded-md border px-1.5 py-0.5 font-mono text-[10.5px] md:inline-block"
          style={{ borderColor: escuro ? "rgba(255,255,255,.2)" : "var(--c-border)", color: escuro ? "rgba(255,255,255,.6)" : "var(--c-ink-mute)" }}
          aria-hidden
        >
          {atalho}
        </kbd>
      </div>

      <dl className={cn("mt-6 grid gap-x-6 gap-y-5", "grid-cols-3")}>
        {stats.map((s) => (
          <div key={s.rotulo} className="min-w-0">
            <dt className="min-h-[2.4em] text-[12px] font-medium leading-tight" style={{ color: escuro ? "rgba(255,255,255,.7)" : "var(--c-ink-soft)" }}>
              {s.rotulo}
            </dt>
            <dd className="mt-2">
              <ValorStat n={s.numero} grande={destaque} critico={s.critico} escuro={escuro} />
            </dd>
          </div>
        ))}
      </dl>

      <div className="mt-auto flex flex-wrap items-end justify-between gap-3 pt-6">
        <div className="min-w-0 text-[12.5px]" style={{ color: escuro ? "rgba(255,255,255,.75)" : "var(--c-ink-soft)" }}>
          {rodape}
        </div>
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-[20px] px-4 py-2 text-[13px] font-semibold transition-[background-color,gap] duration-150 group-hover:gap-2.5",
          )}
          style={destaque ? { background: "var(--signal)", color: "#fff", boxShadow: "0 4px 10px rgba(224,49,49,.28)" } : { background: "var(--bg-subtle)", color: "var(--c-ink)" }}
        >
          {cta}
          <ArrowRight className="h-4 w-4" strokeWidth={2} aria-hidden />
        </span>
      </div>
    </>
  );

  const classe = cn(
    "group relative flex min-h-[260px] flex-col overflow-hidden rounded-[14px] p-5 text-left outline-none transition-[box-shadow,border-color,transform] duration-150 md:p-7",
    "focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[var(--signal)] active:scale-[0.995]",
    destaque ? "md:min-h-[340px]" : "border hover:border-[var(--c-border-strong)]",
  );
  const estilo: React.CSSProperties = destaque
    ? { background: "#1B2430", boxShadow: "0 1px 2px rgba(15,20,27,.2), 0 12px 32px -12px rgba(15,20,27,.45)" }
    : { background: "var(--bg-elevated)", borderColor: "var(--c-border)", boxShadow: "0 1px 2px rgba(27,36,48,.05)" };
  const rotulo = `${titulo}. ${stats.map(textoStat).join(". ")}. ${cta}.`;

  if (href) {
    return (
      <a href={href} className={classe} style={estilo} aria-label={rotulo} onClick={() => gravarUltimaArea(area)}>
        {conteudo}
      </a>
    );
  }
  return (
    <Link to={to} className={classe} style={estilo} aria-label={rotulo} onClick={() => gravarUltimaArea(area)}>
      {conteudo}
    </Link>
  );
}

interface Atalho {
  id: string;
  rotulo: string;
  descricao: string;
  icone: LucideIcon;
  to: string;
  antes?: () => void;
  area: Area;
}

function BlocoAtalho({ a }: { a: Atalho }) {
  const Icone = a.icone;
  return (
    <Link
      to={a.to}
      onClick={() => {
        a.antes?.();
        gravarUltimaArea(a.area);
      }}
      className="group flex min-h-[88px] items-start gap-3 rounded-[12px] border p-4 outline-none transition-[border-color,box-shadow,transform] duration-150 hover:border-[var(--c-border-strong)] hover:shadow-[0_6px_16px_-10px_rgba(27,36,48,.35)] focus-visible:ring-2 focus-visible:ring-[var(--signal)] focus-visible:ring-offset-2 active:scale-[0.96]"
      style={{ background: "var(--bg-elevated)", borderColor: "var(--c-border)" }}
    >
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[8px]" style={{ background: "var(--bg-subtle)", color: "var(--c-ink)" }}>
        <Icone className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden />
      </span>
      <span className="min-w-0">
        <span className="block text-[13.5px] font-semibold leading-tight" style={{ color: "var(--c-ink)" }}>
          {a.rotulo}
        </span>
        <span className="mt-1 block text-[12px] leading-snug" style={{ color: "var(--c-ink-soft)" }}>
          {a.descricao}
        </span>
      </span>
    </Link>
  );
}

export default function Inicio() {
  const { operador, user } = useAuth();
  const areas = useAreas();
  const navigate = useNavigate();
  const demo = OPERACAO_DEMO;
  const veRel = areas.veRelacionamento || demo;
  const veOp = areas.podeAbrirOperacao;

  const rel = useNumerosRelacionamento(veRel);
  const op = useNumerosOperacao(veOp);
  const ultima = useMemo(() => lerUltimaArea(), []);

  const urgRel =
    rel.aguardando.valor != null ? rel.aguardando.valor + (rel.clienteRespondeu.valor ?? 0) : null;
  const urgOp = op.precisaVoce.valor != null ? op.precisaVoce.valor + (op.conselheiro.valor ?? 0) : null;
  const destaque = areaDestaque({ relacionamento: urgRel, operacao: urgOp }, { relacionamento: veRel, operacao: veOp }, ultima);

  const blocoRel = veRel ? (
    <BlocoArea
      key="rel"
      area="relacionamento"
      destaque={destaque === "relacionamento"}
      titulo="Relacionamento"
      descricao="Cards de clientes no Inbox: o que espera sua validação e quem já respondeu."
      to="/inbox"
      href={HREF_REL_DEMO}
      atalho="g r"
      cta="Abrir o Inbox"
      stats={[
        { rotulo: "Aguardando você", numero: rel.aguardando, critico: true },
        { rotulo: "SLA em risco", numero: rel.slaRisco, critico: true },
        { rotulo: "Cliente respondeu", numero: rel.clienteRespondeu },
      ]}
      rodape={<span>{rel.escopo === "demonstração" ? "Dados fictícios de demonstração" : `Contagem ${rel.escopo}`} · atualiza sozinha</span>}
    />
  ) : null;

  const blocoOp = veOp ? (
    <BlocoArea
      key="op"
      area="operacao"
      destaque={destaque === "operacao"}
      titulo="Operação"
      descricao="Notas paradas no SSW: o que pede decisão, o que já tem sugestão firme e os avisos do conselheiro."
      to="/operacao"
      atalho="g o"
      cta="Abrir a Operação"
      stats={[
        { rotulo: "Precisa de você", numero: op.precisaVoce, critico: true },
        { rotulo: "Com sugestão", numero: op.comSugestao },
        { rotulo: "Conselheiro", numero: op.conselheiro, critico: true },
      ]}
      rodape={
        op.carregando ? (
          <span>Lendo a fila…</span>
        ) : op.erro ? (
          <span>Não deu para ler a fila agora.</span>
        ) : op.gargalo ? (
          <span>
            Maior gargalo: <strong className="font-semibold">{op.gargalo.unidade}</strong> · {op.gargalo.paradas}{" "}
            {op.gargalo.paradas === 1 ? "nota parada" : "notas paradas"} em {op.gargalo.setor}
          </span>
        ) : (
          <span>Nenhuma filial com nota parada além do prazo.</span>
        )
      }
    />
  ) : null;

  const [grande, pequeno] = destaque === "operacao" ? [blocoOp, blocoRel] : [blocoRel, blocoOp];

  const atalhos: Atalho[] = [
    ...(veOp
      ? ([
          { id: "op-gestao", rotulo: "Gestão da Operação", descricao: "Filiais, setores e gargalos", icone: Gauge, to: "/operacao", antes: () => prepararAbaOperacao("gestao"), area: "operacao" },
          { id: "op-comprovantes", rotulo: "Comprovantes", descricao: "Canhotos que faltam", icone: ClipboardCheck, to: "/operacao", antes: () => prepararAbaOperacao("comprovantes"), area: "operacao" },
          { id: "op-torre", rotulo: "Torre", descricao: "Agentes e conselheiro", icone: RadioTower, to: "/operacao", antes: () => prepararAbaOperacao("torre"), area: "operacao" },
        ] satisfies Atalho[])
      : []),
    ...(areas.veRelacionamento
      ? ([
          { id: "rel-agentes", rotulo: "Gestão Agentes", descricao: "Como os agentes estão decidindo", icone: Bot, to: "/gestao-agentes", area: "relacionamento" },
          { id: "rel-operadores", rotulo: "Gestão Operadores", descricao: "Carga e ritmo da equipe", icone: Users, to: "/gestao-operadores", area: "relacionamento" },
          { id: "rel-indicadores", rotulo: "Indicadores", descricao: "Números do Relacionamento", icone: LayoutDashboard, to: "/indicadores", area: "relacionamento" },
          { id: "rel-aprendizado", rotulo: "Aprendizado", descricao: "O que a IA aprendeu com vocês", icone: GraduationCap, to: "/aprendizado", area: "relacionamento" },
        ] satisfies Atalho[])
      : []),
  ];

  const nome = primeiroNome(operador?.nome ?? (demo ? "Gestor" : user?.email ?? ""));

  return (
    <div className="mx-auto w-full max-w-[1240px] px-4 pb-12 pt-6 md:px-8 md:pt-10">
      <header className="mb-6 md:mb-8">
        <p className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--c-ink-mute)" }}>
          Início{demo ? " · demonstração" : ""}
        </p>
        <h1 className="mt-1 text-[24px] font-semibold leading-tight tracking-tight md:text-[28px]" style={{ color: "var(--c-ink)" }}>
          {saudacao()}, {nome}. Por onde você entra?
        </h1>
      </header>

      <section aria-label="Áreas" className="grid gap-4 lg:grid-cols-12">
        {grande && <div className={cn("[&>*]:h-full", pequeno ? "lg:col-span-8" : "lg:col-span-12")}>{grande}</div>}
        {pequeno && <div className="lg:col-span-4 [&>*]:h-full">{pequeno}</div>}
      </section>

      {atalhos.length > 0 && (
        <section aria-labelledby="titulo-atalhos" className="mt-8">
          <h2 id="titulo-atalhos" className="mb-3 font-mono text-[10.5px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--c-ink-mute)" }}>
            Gestão
          </h2>
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {atalhos.map((a) => (
              <li key={a.id} className="[&>*]:h-full">
                <BlocoAtalho a={a} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {!veRel && !veOp && (
        <p className="mt-6 text-[13px]" style={{ color: "var(--c-ink-soft)" }}>
          Seu acesso ainda não tem nenhuma área.{" "}
          <button type="button" className="underline" onClick={() => navigate("/inbox")}>
            Ir para o Inbox
          </button>
        </p>
      )}
    </div>
  );
}
