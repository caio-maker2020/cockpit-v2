// Renderiza as respostas do agente-chefe como Markdown (Caio 08/08: "igual
// uma conversa com o claude code — bem separadinho"). Tabelas, listas, negrito
// e parágrafos espaçados, no tom compacto do chat.
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function ChatMarkdown({ texto }: { texto: string }) {
  return (
    <div className="chat-md space-y-2 text-[13px] leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: (props) => <p className="my-0" {...props} />,
          ul: (props) => <ul className="my-1 list-disc space-y-0.5 pl-5" {...props} />,
          ol: (props) => <ol className="my-1 list-decimal space-y-0.5 pl-5" {...props} />,
          li: (props) => <li className="marker:text-ink-mute" {...props} />,
          strong: (props) => <strong className="font-semibold text-ink" {...props} />,
          a: (props) => (
            <a className="underline underline-offset-2" target="_blank" rel="noreferrer" {...props} />
          ),
          code: (props) => (
            <code className="rounded bg-bg-subtle px-1 py-0.5 font-mono text-[12px]" {...props} />
          ),
          table: (props) => (
            <div className="my-1.5 overflow-x-auto rounded-lg border border-border">
              <table className="w-full border-collapse text-[12.5px]" {...props} />
            </div>
          ),
          thead: (props) => <thead className="bg-bg-subtle" {...props} />,
          th: (props) => (
            <th
              className="border-b border-border px-2.5 py-1.5 text-left font-mono text-[10.5px] font-semibold uppercase tracking-wider text-ink-soft"
              {...props}
            />
          ),
          td: (props) => (
            <td className="border-b border-border px-2.5 py-1.5 tabular-nums last:border-b-0" {...props} />
          ),
          hr: () => <hr className="my-2 border-border" />,
          h1: (props) => <p className="font-semibold text-ink" {...props} />,
          h2: (props) => <p className="font-semibold text-ink" {...props} />,
          h3: (props) => <p className="font-semibold text-ink" {...props} />,
        }}
      >
        {texto}
      </ReactMarkdown>
    </div>
  );
}
