import { useQuery } from "@tanstack/react-query";
import { workspacesQuery } from "@/api/queries";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** A project (a workspace, §4) by name, or `noneLabel` for none: the New ticket dialog's field and
 * the board's filter. */
export function ProjectSelect({
  labelId,
  noneLabel,
  value,
  onChange,
  className,
}: {
  readonly labelId: string;
  readonly noneLabel: string;
  readonly value: string | null;
  readonly onChange: (project: string | null) => void;
  readonly className?: string;
}) {
  const workspaces = useQuery(workspacesQuery);
  const items = [
    { value: null, label: noneLabel },
    ...(workspaces.data?.workspaces ?? []).map((w) => ({
      value: w.id,
      label: w.name,
    })),
  ];
  return (
    <Select items={items} value={value} onValueChange={onChange}>
      <SelectTrigger aria-labelledby={labelId} className={className}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value ?? ""} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
