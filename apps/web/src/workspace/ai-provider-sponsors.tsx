import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink } from "lucide-react";
import { loadAIProviderSponsors, type AIProviderSponsor } from "./ai-provider-sponsors-data";

export function AIProviderSponsors() {
  const { t } = useTranslation("ai");
  const [sponsors, setSponsors] = useState<AIProviderSponsor[]>([]);

  useEffect(() => {
    let active = true;
    void loadAIProviderSponsors()
      .then((data) => {
        if (active) setSponsors(data);
      })
      // Promotion availability must never block provider configuration.
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  if (!sponsors.length) return null;

  return (
    <section
      aria-label={t("sponsoredProviders")}
      className="ai-provider-sponsors flex min-h-0 min-w-0 shrink-0 flex-col gap-2 border-t border-border pt-4 lg:max-h-full lg:w-80 lg:gap-3 lg:self-start lg:rounded-xl lg:border lg:bg-sheet lg:p-4 lg:shadow-sm"
    >
      <h3 className="m-0 shrink-0 text-xs font-medium text-muted">{t("sponsoredProviders")}</h3>
      <div className="grid min-h-0 min-w-0 content-start gap-2 lg:overflow-x-hidden lg:overflow-y-auto lg:overscroll-contain">
        {sponsors.map((sponsor) => (
          <a
            key={sponsor.id}
            href={sponsor.link}
            target="_blank"
            rel="sponsored noopener noreferrer"
            referrerPolicy="no-referrer"
            className="flex min-w-0 items-start gap-2.5 rounded-md py-2 px-1 text-foreground no-underline outline-none hover:bg-soft focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          >
            <SponsorIcon key={sponsor.icon} sponsor={sponsor} />
            <span className="grid min-w-0 flex-1 gap-0.5 [overflow-wrap:anywhere]">
              <span className="truncate text-[13px] font-medium" title={sponsor.name}>
                {sponsor.name}
              </span>
              {sponsor.description && (
                <span className="line-clamp-2 text-xs leading-5 text-muted lg:line-clamp-4" title={sponsor.description}>
                  {sponsor.description}
                </span>
              )}
            </span>
            <ExternalLink className="size-3.5 shrink-0 text-muted" aria-hidden="true" />
            <span className="sr-only">{t("opensInNewTab")}</span>
          </a>
        ))}
      </div>
    </section>
  );
}

function SponsorIcon({ sponsor }: { sponsor: AIProviderSponsor }) {
  const [failed, setFailed] = useState(false);
  return sponsor.icon && !failed ? (
    <img
      src={sponsor.icon}
      alt=""
      width={32}
      height={32}
      loading="lazy"
      referrerPolicy="no-referrer"
      className="size-5 shrink-0 rounded object-contain lg:size-8"
      onError={() => setFailed(true)}
    />
  ) : (
    <span aria-hidden="true" className="flex size-5 shrink-0 items-center lg:size-8 justify-center text-sm font-medium">
      {Array.from(sponsor.name)[0]}
    </span>
  );
}