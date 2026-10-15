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
