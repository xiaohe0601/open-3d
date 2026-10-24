import { useTranslation } from "react-i18next";
import type { TaskPlan } from "@open-3d/ai/runtime";
import { Button } from "../../components/ui/button";

export function ModraTaskPlan({
  plan,
  onBuild,
  disabled,
}: {
  plan: TaskPlan;
  onBuild?: () => void;
  disabled: boolean;
}) {
  const { t } = useTranslation("ai");
  return (
    <section className="mt-2 grid gap-2 border-t border-border pt-2 text-[13px]" aria-label={t("taskPlan")}>
      <strong>{t("taskPlan")}</strong>
      <ol className="m-0 grid gap-1 pl-5">
        {plan.steps.map((step) => (
          <li key={step.id} data-plan-step={step.id}>
            <span className="break-words">{step.label}</span>
            <span className="ml-2 text-muted">{t(`planStatus.${step.status}`)}</span>
          </li>
        ))}
      </ol>
      <span className="text-muted">{t("planNotApplied")}</span>
      {onBuild && (
        <Button size="sm" variant="outline" disabled={disabled} onClick={onBuild}>
          {t("buildFromPlan")}
        </Button>
      )}
    </section>
  );
}