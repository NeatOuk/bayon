import { PageContainer } from "@/components/page-container";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { NotificationsSettings } from "@/notify/notifications-settings";
import { GENERAL_HREF, NOTIFICATIONS_HREF, ROLES_HREF } from "@/routing";
import { GeneralSettings } from "@/settings/general-settings";
import { RolesScreen } from "@/settings/roles-screen";

export type SettingsTab = "general" | "roles" | "notifications";

const HREF: Readonly<Record<SettingsTab, string>> = {
  general: GENERAL_HREF,
  roles: ROLES_HREF,
  notifications: NOTIFICATIONS_HREF,
};

const isTab = (value: unknown): value is SettingsTab =>
  value === "general" || value === "roles" || value === "notifications";

/**
 * Settings (§12.3): General (the whitelisted settings), Notifications (the channels and
 * their destinations) and Roles, a tab each; the hash picks it.
 */
export function SettingsScreen({ tab }: { readonly tab: SettingsTab }) {
  return (
    <PageContainer size="wide">
      <Tabs
        value={tab}
        onValueChange={(value: unknown) => {
          if (isTab(value)) window.location.hash = HREF[value];
        }}
        className="gap-5"
      >
        <TabsList aria-label="settings sections">
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="notifications">Notifications</TabsTrigger>
          <TabsTrigger value="roles">Roles</TabsTrigger>
        </TabsList>
        <TabsContent value="general">
          <GeneralSettings />
        </TabsContent>
        <TabsContent value="notifications">
          <NotificationsSettings />
        </TabsContent>
        <TabsContent value="roles">
          <RolesScreen />
        </TabsContent>
      </Tabs>
    </PageContainer>
  );
}
