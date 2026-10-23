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
    <section aria-label={t("sponsoredProviders")} className="grid gap-2 border-t border-border pt-3">
      <h3 className="m-0 text-[13px] font-medium text-muted">{t("sponsoredProviders")}</h3>
      <div className="grid gap-1">
        {sponsors.map((sponsor) => (
          <a
            key={sponsor.id}
            href={sponsor.link}
            target="_blank"
            rel="sponsored noopener noreferrer"
            referrerPolicy="no-referrer"
            className="flex min-w-0 items-center gap-3 rounded-md p-2 text-foreground no-underline outline-none hover:bg-soft focus-visible:ring-2 focus-visible:ring-ring"
          >
            <SponsorIcon key={sponsor.icon} sponsor={sponsor} />
            <span className="grid min-w-0 flex-1 gap-0.5 [overflow-wrap:anywhere]">
              <span className="text-[13px] font-medium">{sponsor.name}</span>
              {sponsor.description && <span className="text-xs leading-5 text-muted">{sponsor.description}</span>}
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
      className="size-8 shrink-0 rounded-md object-contain"
      onError={() => setFailed(true)}
    />
  ) : (
    <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center text-sm font-medium">
      {Array.from(sponsor.name)[0]}
    </span>
  );
}