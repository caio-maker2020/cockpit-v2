/**
 * Kit estrutural do cockpit — fonte ÚNICA dos padrões visuais (page/board/lane/
 * card/summary/empty) compartilhados por Inbox, Extravios e Conflitos.
 * Extraído do Inbox aprovado. Telas diferem por CONTEÚDO, não por desenho.
 */
export { CockpitBoard } from "./CockpitBoard";
export { CockpitColumn } from "./CockpitColumn";
export { CockpitCard } from "./CockpitCard";
export { CardIdentity } from "./CardIdentity";
export { CardMetaFooter } from "./CardMetaFooter";
export { CockpitEmptyState } from "./CockpitEmptyState";
export { CockpitSummaryBar, CockpitStatTile } from "./CockpitSummary";
export { Chip, type ChipTone } from "./Chip";
export { dotClass, spineClass, type Tone } from "./tones";
