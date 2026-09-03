import { useNavigate, useLocation } from 'react-router-dom';
import UserMenu from './UserMenu.jsx';
import styles from './NavBar.module.css';

const LINKS = [
  { to: '/', label: 'Bibliothèque' },
  { to: '/profile', label: 'Profil' },
];

// Sticky top bar shared by Library and Profile — Reader keeps its own
// auto-hiding immersive toolbar (already has a back-link + UserMenu there).
export default function NavBar({ user, onSignOut }) {
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <nav className={styles.bar}>
      <button className={styles.brand} onClick={() => navigate('/')} aria-label="Aller à la bibliothèque">
        <span className={styles.brandMark}>✦</span>
        <span className={styles.brandName}>Bibliothèque</span>
      </button>

      <div className={styles.links}>
        {LINKS.map((link) => (
          <button
            key={link.to}
            className={`${styles.link} ${location.pathname === link.to ? styles.linkActive : ''}`}
            onClick={() => navigate(link.to)}
          >
            {link.label}
          </button>
        ))}
      </div>

      <div className={styles.spacer} />

      <UserMenu user={user} onSignOut={onSignOut} />
    </nav>
  );
}
