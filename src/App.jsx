import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Library from './pages/Library.jsx';
import Reader from './pages/Reader.jsx';
import Auth from './pages/Auth.jsx';
import ProtectedRoute from './components/ProtectedRoute.jsx';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/auth" element={<Auth />} />
        <Route path="/" element={
          <ProtectedRoute><Library /></ProtectedRoute>
        } />
        <Route path="/read/:id" element={
          <ProtectedRoute><Reader /></ProtectedRoute>
        } />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
