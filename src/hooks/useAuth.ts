import { useCallback, useEffect, useRef, useState } from 'react';
import { onAuthStateChanged, type User } from 'firebase/auth';
import { auth, signInWithGoogle, signOutUser, testFirestoreConnection } from '../services/firebase';
import { ensureUserProfile } from '../services/persistence';

export type FirestoreStatus = 'connected' | 'offline' | 'error' | 'checking';

/** Default alert threshold written to a brand-new profile (the user can change it later). */
const DEFAULT_MIN_EV = 3;

export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  /** True once the user's profile document exists, so dependent loads can safely start. */
  const [profileReady, setProfileReady] = useState(false);
  const [firestoreStatus, setFirestoreStatus] = useState<FirestoreStatus>('checking');
  const userRef = useRef<User | null>(user);
  userRef.current = user;

  useEffect(() => {
    let active = true;
    testFirestoreConnection().then((status) => {
      if (active) setFirestoreStatus(status);
    });

    const unsub = onAuthStateChanged(auth, async (nextUser) => {
      if (!active) return;
      setUser(nextUser);
      setProfileReady(false);
      if (!nextUser) return;
      try {
        await ensureUserProfile(nextUser, DEFAULT_MIN_EV);
      } catch {
        // Logged by handleFirestoreError; loads below simply return empty
      }
      if (active) setProfileReady(true);
    });

    return () => {
      active = false;
      unsub();
    };
  }, []);

  const signIn = useCallback(async () => {
    try {
      await signInWithGoogle();
    } catch {
      // Popup closed or blocked
    }
  }, []);

  const signOut = useCallback(async () => {
    await signOutUser();
  }, []);

  /** Fresh Firebase ID token for authenticating calls to this app's own server. */
  const getIdToken = useCallback(async (): Promise<string | null> => {
    const u = userRef.current;
    if (!u) return null;
    try {
      return await u.getIdToken();
    } catch {
      return null;
    }
  }, []);

  return { user, userRef, profileReady, firestoreStatus, signIn, signOut, getIdToken };
}
