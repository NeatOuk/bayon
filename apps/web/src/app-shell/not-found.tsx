import { CompassIcon } from "lucide-react";
import { SHORTCUT_LABEL } from "@/app-shell/palette-model";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { TextLink } from "@/components/text-link";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { FLEET_HREF } from "@/routing";

/**
 * An address no screen answers to: said plainly, with the way to the Fleet, rather than
 * the Fleet itself under an address that names something else.
 */
export function NotFound({ hash }: { readonly hash: string }) {
  return (
    <PageContainer>
      <PageHeader title="Not found" />
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <CompassIcon aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>Nothing lives at this address</EmptyTitle>
          <EmptyDescription>
            <code className="font-mono break-all">{hash}</code> names no screen:
            a mistyped link, or one from an older version.{" "}
            <TextLink inline href={FLEET_HREF}>
              Go to the Fleet
            </TextLink>{" "}
            or press {SHORTCUT_LABEL} to search.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </PageContainer>
  );
}
