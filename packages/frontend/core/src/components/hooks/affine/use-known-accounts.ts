import { AuthService } from '@affine/core/modules/cloud';
import { useLiveData, useService } from '@toeverything/infra';
import { useCallback, useEffect, useState } from 'react';

export interface KnownAccount {
  id: string;
  email: string;
  name?: string;
  avatar?: string;
  serverBaseUrl?: string;
}

const STORAGE_KEY = 'affine:known-accounts';

function getStoredAccounts(): KnownAccount[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function setStoredAccounts(accounts: KnownAccount[]) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(accounts));
  } catch (e) {
    console.error('Failed to save known accounts to localStorage', e);
  }
}

export const useKnownAccounts = () => {
  const authService = useService(AuthService);
  const account = useLiveData(authService.session.account$);
  const [knownAccounts, setKnownAccounts] = useState<KnownAccount[]>(getStoredAccounts);

  // Sync current account to known accounts whenever it changes and is authenticated
  useEffect(() => {
    if (account?.id && account?.email) {
      setKnownAccounts(prev => {
        const existingIndex = prev.findIndex(a => a.id === account.id || a.email === account.email);
        const updatedAccount: KnownAccount = {
          id: account.id,
          email: account.email,
          name: account.label ?? undefined,
          avatar: account.avatar ?? undefined,
        };

        let updatedList: KnownAccount[];
        if (existingIndex >= 0) {
          updatedList = [...prev];
          updatedList[existingIndex] = {
            ...updatedList[existingIndex],
            ...updatedAccount,
          };
        } else {
          updatedList = [...prev, updatedAccount];
        }

        setStoredAccounts(updatedList);
        return updatedList;
      });
    }
  }, [account?.id, account?.email, account?.label, account?.avatar]);

  // Also sync any other users already authenticated in the current backend session
  useEffect(() => {
    if (!account?.id) return;
    fetch('/api/auth/users')
      .then(res => (res.ok ? res.json() : null))
      .then((data: { users?: Array<{ id: string; email: string; name?: string | null; avatarUrl?: string | null }> } | null) => {
        if (!data?.users?.length) return;
        setKnownAccounts(prev => {
          let changed = false;
          const next = [...prev];
          for (const u of data.users) {
            const idx = next.findIndex(a => a.id === u.id || a.email === u.email);
            if (idx === -1) {
              next.push({
                id: u.id,
                email: u.email,
                name: u.name ?? undefined,
                avatar: u.avatarUrl ?? undefined,
              });
              changed = true;
            }
          }
          if (changed) {
            setStoredAccounts(next);
            return next;
          }
          return prev;
        });
      })
      .catch(() => {});
  }, [account?.id]);

  const removeAccount = useCallback((id: string) => {
    setKnownAccounts(prev => {
      const next = prev.filter(a => a.id !== id);
      setStoredAccounts(next);
      return next;
    });
  }, []);

  return {
    knownAccounts,
    currentAccount: account,
    removeAccount,
  };
};
