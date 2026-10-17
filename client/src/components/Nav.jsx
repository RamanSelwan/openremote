import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';

export default function Nav() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  return (
    <header className="nav">
      <Link to="/" className="brand">
        <span className="brand-mark">◉</span> OpenRemote
      </Link>
      <div className="nav-right">
        {user && (
          <span className="nav-user" title={user.email}>
            {user.name}
            {user.role === 'admin' && <em className="badge badge-admin">admin</em>}
          </span>
        )}
        <button
          className="btn btn-ghost"
          onClick={() => {
            logout();
            navigate('/login');
          }}
        >
          Sign out
        </button>
      </div>
    </header>
  );
}
