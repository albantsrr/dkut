import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import styles from './UserMenu.module.css';

// Avatar button + dropdown (Profil / Déconnexion), shared between Library
// and Reader so account access lives in one place instead of each page
// building its own header actions.
export default function UserMenu({ user, onSignOut }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        className={styles.avatarBtn}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={user?.name || user?.email}
      >
        {user?.picture ? (
          <img src={user.picture} alt={user.name} className={styles.avatar} referrerPolicy="no-referrer" />
        ) : (
          <span className={styles.avatarFallback}>{(user?.name || user?.email || '?')[0].toUpperCase()}</span>
        )}
      </button>

      {open && (
        <div className={styles.menu} role="menu">
          <div className={styles.menuUser}>
            <span className={styles.menuName}>{user?.name}</span>
            <span className={styles.menuEmail}>{user?.email}</span>
          </div>
          <button
            className={styles.menuItem}
            role="menuitem"
            onClick={() => { setOpen(false); navigate('/profile'); }}
          >
            Profil
          </button>
          <button
            className={styles.menuItem}
            role="menuitem"
            onClick={() => { setOpen(false); onSignOut(); }}
          >
            Déconnexion
          </button>
        </div>
      )}
    </div>
  );
}
