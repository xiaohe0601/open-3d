import { Children, isValidElement, memo, useEffect, useRef, useState, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import { Check, Copy } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";

export const MAX_MARKDOWN_CHARACTERS = 65_536;

export function safeMessageURL(value: string): string | undefined {
  try {
    const url = new URL(value);
    if ((url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password) return url.href;
  } catch {
    // Relative links have no stable, safe destination in a local transcript.
  }
  return undefined;
}

function plainText(children: ReactNode): string {
  return Children.toArray(children)
    .map((child): string =>
      typeof child === "string" || typeof child === "number"
        ? String(child)
        : isValidElement<{ children?: ReactNode }>(child)
          ? plainText(child.props.children)
          : "",
    )
    .join("");
}

export function CopyMessageText({ text, code = false }: { text: string; code?: boolean }) {
  const { t } = useTranslation("ai");
  const [result, setResult] = useState<"copied" | "copyFailed" | null>(null);
  const attempt = useRef(0);
  const reset = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    setResult(null);
    return () => {
      attempt.current++;
      clearTimeout(reset.current);
    };
  }, [text]);
  return (
    <div className="relative flex min-w-0 flex-wrap items-center gap-1 text-[13px] text-muted">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className={code ? undefined : "size-6 [&_svg]:size-3"}
        aria-label={t(code ? "copyCode" : "copyMessage")}
        title={t(result ?? (code ? "copyCode" : "copyMessage"))}
        onClick={() => {
          const current = ++attempt.current;
          clearTimeout(reset.current);
          setResult(null);
          void Promise.resolve()
            .then(() => navigator.clipboard.writeText(text))
            .then(
              () => {
                if (current !== attempt.current) return;
                setResult("copied");
                reset.current = setTimeout(() => {
                  if (current === attempt.current) setResult(null);
                }, 3000);
              },
              () => {
                if (current === attempt.current) setResult("copyFailed");
              },
            );
        }}
      >
        {result === "copied" ? (
          <Check className={code ? undefined : "size-3"} />
        ) : (
          <Copy className={code ? undefined : "size-3"} />
        )}
      </Button>
      {result && (
        // Keep the absolute live region inside the scrolled button, not an outer scroll container.
        <span className="sr-only top-0 left-0" role="status">
          {t(result)}
        </span>
      )}
    </div>
  );
}

function BlockedImage({ alt }: { alt?: string }) {
  const { t } = useTranslation("ai");
  return <span className="text-muted">{t("remoteImageBlocked", { name: alt ?? "" })}</span>;
}

const components: Components = {
  a: ({ href, children }) =>
    href ? (
      <a href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  img: BlockedImage,
  pre: ({ children }) => (
    <div className="my-2 min-w-0 rounded-md bg-soft">
      <CopyMessageText text={plainText(children)} code />
      <pre>{children}</pre>
    </div>
  ),
};

/** Parsing is bounded, but full original text is retained for reading and copying. */
export const ModraMessageContent = memo(function ModraMessageContent({ text }: { text: string }) {
  const { t } = useTranslation("ai");
  if (!text.trim()) return <p className="mt-1 mb-0 whitespace-pre-wrap text-[13px] leading-6">{text}</p>;
  if (text.length > MAX_MARKDOWN_CHARACTERS)
    return (
      <div className="mt-1 min-w-0 text-[13px] leading-6">
        <p className="m-0 text-muted">{t("markdownPlainFallback")}</p>
        <p className="m-0 break-words whitespace-pre-wrap">{text}</p>
      </div>
    );
  return (
    <div className="modra-markdown mt-1 min-w-0 text-[13px] leading-6 [overflow-wrap:anywhere] [&_a]:underline [&_blockquote]:pl-3 [&_blockquote]:text-muted [&_code]:font-mono [&_h1]:text-base [&_h2]:text-base [&_h3]:text-sm [&_h4]:text-sm [&_h5]:text-sm [&_h6]:text-sm [&_li]:my-0.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1 [&_p]:whitespace-pre-wrap [&_pre]:m-0 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:p-2 [&_ul]:list-disc [&_ul]:pl-5">
      <Markdown skipHtml urlTransform={(url) => safeMessageURL(url) ?? ""} components={components}>
        {text}
      </Markdown>
    </div>
  );
});