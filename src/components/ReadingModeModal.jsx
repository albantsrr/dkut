import styles from './ReadingModeModal.module.css';

/**
 * Small choice shown when opening a book: free reading vs. Pomodoro learning
 * mode. The choice is passed to Reader.jsx via router state and locked for
 * the whole reading session — there is no mid-session toggle, so this is the
 * only place the choice is made.
 */
export default function ReadingModeModal({ book, onChoose, onClose }) {
  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <p className={styles.title}>« {book.title} »</p>
        <p className={styles.subtitle}>Comment veux-tu lire ce livre ?</p>

        <div className={styles.choices}>
          <button className={styles.choiceBtn} onClick={() => onChoose('free')}>
            <span className={styles.choiceLabel}>Lecture libre</span>
            <span className={styles.choiceHint}>Sans minuteur, comme d'habitude</span>
          </button>
          <button className={styles.choiceBtn} onClick={() => onChoose('learning')}>
            <span className={styles.choiceLabel}>Commencer l'apprentissage</span>
            <span className={styles.choiceHint}>Cycles de 25 min avec exercices à la clé</span>
          </button>
        </div>

        <button className={styles.cancelBtn} onClick={onClose}>Annuler</button>
      </div>
    </div>
  );
}
