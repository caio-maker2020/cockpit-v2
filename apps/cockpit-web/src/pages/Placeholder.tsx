interface PlaceholderProps {
  title: string;
  description?: string;
}

export default function Placeholder({ title, description }: PlaceholderProps) {
  return (
    <div className="flex h-full flex-col">
      <header className="border-b px-5 py-3">
        <h1 className="text-[15px] font-semibold">{title}</h1>
        {description && (
          <p className="text-[12px] text-muted-foreground">{description}</p>
        )}
      </header>
      <div className="flex flex-1 items-center justify-center text-[13px] text-muted-foreground">
        Em construção — funcionalidades virão no próximo prompt.
      </div>
    </div>
  );
}
