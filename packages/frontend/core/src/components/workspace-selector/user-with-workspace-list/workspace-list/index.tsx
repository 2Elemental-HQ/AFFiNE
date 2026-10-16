import { IconButton, Menu, MenuItem, MenuSeparator } from '@affine/component';
import { Divider } from '@affine/component/ui/divider';
import { useEnableCloud } from '@affine/core/components/hooks/affine/use-enable-cloud';
import { useKnownAccounts } from '@affine/core/components/hooks/affine/use-known-accounts';
import { useSignOut } from '@affine/core/components/hooks/affine/use-sign-out';
import { useAsyncCallback } from '@affine/core/components/hooks/affine-async-hooks';
import { useNavigateHelper } from '@affine/core/components/hooks/use-navigate-helper';
import type { AuthAccountInfo, Server } from '@affine/core/modules/cloud';
import { AuthService, ServersService } from '@affine/core/modules/cloud';
import { GlobalDialogService } from '@affine/core/modules/dialogs';
import { GlobalContextService } from '@affine/core/modules/global-context';
import {
  type WorkspaceMetadata,
  WorkspaceService,
  WorkspacesService,
} from '@affine/core/modules/workspace';
import { useI18n } from '@affine/i18n';
import {
  AccountIcon,
  CloudWorkspaceIcon,
  DeleteIcon,
  DoneIcon,
  LocalWorkspaceIcon,
  MoreHorizontalIcon,
  PlusIcon,
  SelfhostIcon,
  SignOutIcon,
} from '@blocksuite/icons/rc';
import {
  FrameworkScope,
  useLiveData,
  useService,
  useServiceOptional,
} from '@toeverything/infra';
import { useCallback, useMemo } from 'react';

import { WorkspaceCard } from '../../workspace-card';
import { AddServer } from '../add-server';
import * as styles from './index.css';

interface WorkspaceModalProps {
  workspaces: WorkspaceMetadata[];
  onClickWorkspace: (workspaceMetadata: WorkspaceMetadata) => void;
  onClickWorkspaceSetting?: (workspaceMetadata: WorkspaceMetadata) => void;
  onClickEnableCloud?: (meta: WorkspaceMetadata) => void;
  onNewWorkspace: () => void;
  onAddWorkspace: () => void;
}

const WorkspaceServerInfo = ({
  server,
  name,
  account,
  accountStatus,
  onDeleteServer,
  onSignOut,
  onAddAccount,
  onSwitchAccount,
}: {
  server: string;
  name: string;
  account?: AuthAccountInfo | null;
  accountStatus?: 'authenticated' | 'unauthenticated';
  onDeleteServer?: () => void;
  onSignOut?: () => void;
  onAddAccount?: () => void;
  onSwitchAccount?: (email: string) => void;
}) => {
  const t = useI18n();
  const { knownAccounts } = useKnownAccounts();
  const isCloud = server !== 'local';
  const isAffineCloud = server === 'affine-cloud';
  const Icon = isAffineCloud
    ? CloudWorkspaceIcon
    : isCloud
      ? SelfhostIcon
      : LocalWorkspaceIcon;

  const otherAccounts = useMemo(
    () => knownAccounts.filter(a => a.email !== account?.email),
    [knownAccounts, account?.email]
  );

  const menuItems = useMemo(() => {
    const items = [];

    // Switch account section if there are multiple accounts or user wants to add an account
    if (isCloud && accountStatus === 'authenticated') {
      if (otherAccounts.length > 0) {
        items.push(
          ...otherAccounts.map(other => (
            <MenuItem
              key={`switch-account-${other.id}`}
              prefixIcon={<AccountIcon />}
              onClick={() => onSwitchAccount?.(other.email)}
            >
              <div className={styles.accountMenuItem}>
                <div className={styles.accountInfo}>
                  <div className={styles.accountName}>
                    {other.name || other.email}
                  </div>
                  {other.name ? (
                    <div className={styles.accountEmail}>{other.email}</div>
                  ) : null}
                </div>
              </div>
            </MenuItem>
          ))
        );
      }

      items.push(
        <MenuItem
          key="add-account"
          prefixIcon={<PlusIcon />}
          onClick={onAddAccount}
        >
          Add account
        </MenuItem>
      );

      items.push(<MenuSeparator key="account-separator" />);
    }

    if (server !== 'affine-cloud' && server !== 'local') {
      items.push(
        <MenuItem
          prefixIcon={<DeleteIcon />}
          type="danger"
          key="delete-server"
          onClick={onDeleteServer}
        >
          {t['com.affine.server.delete']()}
        </MenuItem>
      );
    }

    if (accountStatus === 'authenticated') {
      items.push(
        <MenuItem
          prefixIcon={<SignOutIcon />}
          key="sign-out"
          onClick={onSignOut}
          type="danger"
        >
          {t['Sign out']()}
        </MenuItem>
      );
    }

    return items;
  }, [
    accountStatus,
    isCloud,
    onAddAccount,
    onDeleteServer,
    onSignOut,
    onSwitchAccount,
    otherAccounts,
    server,
    t,
  ]);

  return (
    <div className={styles.workspaceServer}>
      <div className={styles.workspaceServerIcon}>
        <Icon />
      </div>
      <div className={styles.workspaceServerContent}>
        <div className={styles.workspaceServerName}>{name}</div>
        {isCloud ? (
          <div className={styles.workspaceServerAccount}>
            {account ? account.email : 'Not signed in'}
          </div>
        ) : null}
      </div>
      <div className={styles.workspaceServerSpacer} />
      {menuItems.length ? (
        <Menu items={menuItems}>
          <IconButton
            icon={<MoreHorizontalIcon className={styles.infoMoreIcon} />}
          />
        </Menu>
      ) : null}
    </div>
  );
};

const CloudWorkSpaceList = ({
  server,
  workspaces,
  onClickWorkspace,
  onClickEnableCloud,
}: {
  server: Server;
  workspaces: WorkspaceMetadata[];
  onClickWorkspace: (workspaceMetadata: WorkspaceMetadata) => void;
  onClickEnableCloud?: (meta: WorkspaceMetadata) => void;
}) => {
  const t = useI18n();
  const globalContextService = useService(GlobalContextService);
  const globalDialogService = useService(GlobalDialogService);
  const serverName = useLiveData(server.config$.selector(c => c.serverName));
  const authService = useService(AuthService);
  const serversService = useService(ServersService);
  const account = useLiveData(authService.session.account$);
  const accountStatus = useLiveData(authService.session.status$);
  const navigateHelper = useNavigateHelper();

  const currentWorkspaceFlavour = useLiveData(
    globalContextService.globalContext.workspaceFlavour.$
  );

  const handleDeleteServer = useCallback(() => {
    serversService.removeServer(server.id);

    if (currentWorkspaceFlavour === server.id) {
      const otherWorkspace = workspaces.find(w => w.flavour !== server.id);
      if (otherWorkspace) {
        navigateHelper.openPage(otherWorkspace.id, 'all');
      }
    }
  }, [
    currentWorkspaceFlavour,
    navigateHelper,
    server.id,
    serversService,
    workspaces,
  ]);

  const handleSignOut = useSignOut();

  const handleAddOrSwitchAccount = useAsyncCallback(async (targetEmail?: string) => {
    // 1. If switching to a specific known account, try instant backend session switch first!
    // AFFiNE's backend supports multiple simultaneous UserSessions under a single affine_session cookie.
    if (targetEmail) {
      try {
        const switchRes = await fetch(`${server.baseUrl}/api/auth/switch-user`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: targetEmail }),
        });
        if (switchRes.ok) {
          const switchData = await switchRes.json();
          if (switchData.switched) {
            await authService.session.revalidateOnce();
            window.location.href = '/';
            return;
          }
        }
      } catch {
        /* fallback to sign-in if not yet in current session */
      }
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.setItem('affine:login-hint', targetEmail);
      }
    } else if (typeof sessionStorage !== 'undefined') {
      sessionStorage.removeItem('affine:login-hint');
    }

    // 2. Account is not yet in the active backend session (or user clicked "Add account"):
    // Do NOT call authService.signOut() and do NOT redirect to Authentik end-session portal.
    // Preserving affine_session adds the second account to the same multi-user session,
    // and opening the sign-in modal inside AFFiNE keeps the OAuth flow attached to AFFiNE!
    globalDialogService.open('sign-in', {
      server: server.baseUrl,
    });
  }, [authService.session, globalDialogService, server.baseUrl]);

  return (
    <>
      <WorkspaceServerInfo
        server={server.id}
        name={serverName}
        account={account}
        accountStatus={accountStatus}
        onDeleteServer={handleDeleteServer}
        onSignOut={handleSignOut}
        onAddAccount={() => handleAddOrSwitchAccount()}
        onSwitchAccount={(email) => handleAddOrSwitchAccount(email)}
      />
      {accountStatus === 'unauthenticated' ? (
        <MenuItem key="sign-in" onClick={() => handleAddOrSwitchAccount()}>
          <div className={styles.signInMenuItemContent}>
            <div className={styles.signInIconWrapper}>
              <AccountIcon />
            </div>
            <div className={styles.signInText}>{t['Sign in']()}</div>
          </div>
        </MenuItem>
      ) : null}
      <WorkspaceList
        items={workspaces}
        onClick={onClickWorkspace}
        onEnableCloudClick={onClickEnableCloud}
      />
    </>
  );
};

const LocalWorkspaces = ({
  workspaces,
  onClickWorkspace,
  onClickWorkspaceSetting,
  onClickEnableCloud,
}: Omit<WorkspaceModalProps, 'onNewWorkspace' | 'onAddWorkspace'>) => {
  const t = useI18n();
  if (workspaces.length === 0) {
    return null;
  }
  return (
    <>
      <WorkspaceServerInfo
        server="local"
        name={t['com.affine.workspaceList.workspaceListType.local']()}
      />
      <WorkspaceList
        items={workspaces}
        onClick={onClickWorkspace}
        onSettingClick={onClickWorkspaceSetting}
        onEnableCloudClick={onClickEnableCloud}
      />
    </>
  );
};

export const AFFiNEWorkspaceList = ({
  onEventEnd,
  onClickWorkspace,
  showEnableCloudButton,
}: {
  onClickWorkspace?: (workspaceMetadata: WorkspaceMetadata) => void;
  onEventEnd?: () => void;
  showEnableCloudButton?: boolean;
}) => {
  const workspacesService = useService(WorkspacesService);
  const workspaces = useLiveData(workspacesService.list.workspaces$);

  const confirmEnableCloud = useEnableCloud();

  const serversService = useService(ServersService);
  const servers = useLiveData(serversService.servers$);
  const affineCloudServer = useMemo(
    () => servers.find(s => s.id === 'affine-cloud') as Server,
    [servers]
  );
  const selfhostServers = useMemo(
    () => servers.filter(s => s.id !== 'affine-cloud'),
    [servers]
  );

  const cloudWorkspaces = useMemo(
    () =>
      workspaces.filter(
        ({ flavour }) => flavour !== 'local'
      ) as WorkspaceMetadata[],
    [workspaces]
  );

  const localWorkspaces = useMemo(
    () =>
      workspaces.filter(
        ({ flavour }) => flavour === 'local'
      ) as WorkspaceMetadata[],
    [workspaces]
  );

  const onClickEnableCloud = useCallback(
    (meta: WorkspaceMetadata) => {
      const { workspace, dispose } = workspacesService.open({ metadata: meta });
      confirmEnableCloud(workspace, {
        onFinished: () => {
          dispose();
        },
      });
    },
    [confirmEnableCloud, workspacesService]
  );

  const handleClickWorkspace = useCallback(
    (workspaceMetadata: WorkspaceMetadata) => {
      onClickWorkspace?.(workspaceMetadata);
      onEventEnd?.();
    },
    [onClickWorkspace, onEventEnd]
  );

  return (
    <>
      {/* 1. affine-cloud */}
      <FrameworkScope
        key={affineCloudServer.id}
        scope={affineCloudServer.scope}
      >
        <CloudWorkSpaceList
          server={affineCloudServer}
          workspaces={cloudWorkspaces.filter(
            ({ flavour }) => flavour === affineCloudServer.id
          )}
          onClickWorkspace={handleClickWorkspace}
        />
      </FrameworkScope>
      {(localWorkspaces.length > 0 || selfhostServers.length > 0) && (
        <Divider size="thinner" className={styles.serverDivider} />
      )}

      {/* 2. local */}
      <LocalWorkspaces
        workspaces={localWorkspaces}
        onClickWorkspace={handleClickWorkspace}
        onClickEnableCloud={
          showEnableCloudButton ? onClickEnableCloud : undefined
        }
      />
      {selfhostServers.length > 0 && (
        <Divider size="thinner" className={styles.serverDivider} />
      )}

      {/* 3. selfhost */}
      {selfhostServers.map((server, index) => (
        <FrameworkScope key={server.id} scope={server.scope}>
          <CloudWorkSpaceList
            server={server}
            workspaces={cloudWorkspaces.filter(
              ({ flavour }) => flavour === server.id
            )}
            onClickWorkspace={handleClickWorkspace}
          />
          {index !== selfhostServers.length - 1 && (
            <Divider size="thinner" className={styles.serverDivider} />
          )}
        </FrameworkScope>
      ))}
      <AddServer />
      <Divider size="thinner" />
    </>
  );
};

interface WorkspaceListProps {
  items: WorkspaceMetadata[];
  onClick: (workspace: WorkspaceMetadata) => void;
  onSettingClick?: (workspace: WorkspaceMetadata) => void;
  onEnableCloudClick?: (meta: WorkspaceMetadata) => void;
}

interface SortableWorkspaceItemProps extends Omit<WorkspaceListProps, 'items'> {
  workspaceMetadata: WorkspaceMetadata;
}

const SortableWorkspaceItem = ({
  workspaceMetadata,
  onClick,
  onSettingClick,
  onEnableCloudClick,
}: SortableWorkspaceItemProps) => {
  const handleClick = useCallback(() => {
    onClick(workspaceMetadata);
  }, [onClick, workspaceMetadata]);

  const currentWorkspace = useServiceOptional(WorkspaceService)?.workspace;

  return (
    <WorkspaceCard
      className={styles.workspaceCard}
      infoClassName={styles.workspaceCardInfoContainer}
      workspaceMetadata={workspaceMetadata}
      onClick={handleClick}
      avatarSize={22}
      active={currentWorkspace?.id === workspaceMetadata.id}
      onClickOpenSettings={onSettingClick}
      onClickEnableCloud={onEnableCloudClick}
    />
  );
};

export const WorkspaceList = (props: WorkspaceListProps) => {
  const workspaceList = props.items;

  return workspaceList.map(item => (
    <SortableWorkspaceItem key={item.id} {...props} workspaceMetadata={item} />
  ));
};
