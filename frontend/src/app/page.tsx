'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/lib/auth-context';
import { useRouter } from 'next/navigation';
import { Cloud, Lock, Shield, Zap } from 'lucide-react';

export default function LandingPage() {
  const { user, login, register, loading } = useAuth();
  const router = useRouter();
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!loading && user) {
      router.push('/dashboard');
    }
  }, [user, loading, router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      if (isLogin) {
        await login(email, password);
      } else {
        await register(email, username, password);
      }
    } catch (err: any) {
      setError(err.message || 'Authentication failed');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-950 text-white">
        <div className="animate-pulse flex items-center space-x-2">
          <Cloud className="w-8 h-8 text-cyan-400" />
          <span className="text-xl font-medium">Loading CloudVault...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-gray-900 via-gray-950 to-black text-white flex flex-col md:flex-row relative overflow-hidden">
      
      {/* Background Decor */}
      <div className="absolute top-[-10%] left-[-10%] w-96 h-96 bg-cyan-500/20 rounded-full blur-[100px] pointer-events-none"></div>
      <div className="absolute bottom-[-10%] right-[-10%] w-96 h-96 bg-blue-600/20 rounded-full blur-[100px] pointer-events-none"></div>

      <div className="md:w-1/2 p-12 flex flex-col justify-center items-start space-y-8 z-10">
        <div className="flex items-center space-x-3 text-cyan-400 drop-shadow-[0_0_15px_rgba(34,211,238,0.5)]">
          <Cloud size={56} />
          <h1 className="text-5xl md:text-6xl font-extrabold tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-cyan-400 to-blue-500">
            CloudVault
          </h1>
        </div>
        <p className="text-xl text-gray-300 max-w-lg leading-relaxed font-light">
          Secure, lightning-fast, and unlimited cloud storage. Access your files anywhere, anytime with enterprise-grade encryption.
        </p>
        <div className="space-y-6 pt-4">
          <div className="flex items-center space-x-4">
            <div className="p-3 bg-gray-900/80 border border-gray-800 rounded-xl text-cyan-400 shadow-inner"><Lock size={24} /></div>
            <div>
              <h3 className="font-semibold text-lg text-gray-100">End-to-End Encryption</h3>
              <p className="text-gray-400 text-sm">Your files are encrypted at rest and in transit.</p>
            </div>
          </div>
          <div className="flex items-center space-x-4">
            <div className="p-3 bg-gray-900/80 border border-gray-800 rounded-xl text-cyan-400 shadow-inner"><Zap size={24} /></div>
            <div>
              <h3 className="font-semibold text-lg text-gray-100">Lightning Fast</h3>
              <p className="text-gray-400 text-sm">Powered by globally distributed edge networks.</p>
            </div>
          </div>
          <div className="flex items-center space-x-4">
            <div className="p-3 bg-gray-900/80 border border-gray-800 rounded-xl text-cyan-400 shadow-inner"><Shield size={24} /></div>
            <div>
              <h3 className="font-semibold text-lg text-gray-100">Enterprise Security</h3>
              <p className="text-gray-400 text-sm">Audited architecture ensuring data integrity.</p>
            </div>
          </div>
        </div>
      </div>
      
      <div className="md:w-1/2 flex items-center justify-center p-8 z-10">
        <div className="bg-gray-900/50 backdrop-blur-xl border border-gray-700/50 p-10 rounded-3xl shadow-2xl w-full max-w-md transition-all duration-500 hover:shadow-cyan-500/10 hover:border-gray-600/50 group">
          <h2 className="text-3xl font-bold mb-8 text-center bg-clip-text text-transparent bg-gradient-to-r from-gray-100 to-gray-400">
            {isLogin ? 'Welcome Back' : 'Create Account'}
          </h2>
          
          {error && (
            <div className="bg-red-500/10 border border-red-500/30 text-red-400 p-4 rounded-xl mb-6 text-sm flex items-center">
              <div className="mr-3">⚠️</div>
              {error}
            </div>
          )}
          
          <form onSubmit={handleSubmit} className="space-y-5">
            <div className={`overflow-hidden transition-all duration-500 ${!isLogin ? 'max-h-24 opacity-100 mb-5' : 'max-h-0 opacity-0 mb-0'}`}>
              <label className="block text-sm font-medium text-gray-400 mb-1.5">Username</label>
              <input
                type="text"
                required={!isLogin}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full bg-gray-950/50 border border-gray-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-cyan-500/50 focus:border-cyan-500/50 transition-all placeholder:text-gray-600"
                placeholder="johndoe"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-400 mb-1.5">Email</label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full bg-gray-950/50 border border-gray-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-cyan-500/50 focus:border-cyan-500/50 transition-all placeholder:text-gray-600"
                placeholder="you@example.com"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-400 mb-1.5">Password</label>
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-gray-950/50 border border-gray-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-cyan-500/50 focus:border-cyan-500/50 transition-all placeholder:text-gray-600"
                placeholder="••••••••"
              />
            </div>
            
            <button
              type="submit"
              disabled={submitting}
              className="w-full mt-8 bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white font-semibold py-3.5 px-4 rounded-xl transition-all duration-300 focus:outline-none focus:ring-2 focus:ring-cyan-400 focus:ring-offset-2 focus:ring-offset-gray-900 shadow-lg shadow-cyan-900/30 disabled:opacity-50 disabled:cursor-not-allowed group-hover:shadow-cyan-900/50"
            >
              {submitting ? 'Please wait...' : (isLogin ? 'Sign In' : 'Sign Up')}
            </button>
          </form>
          
          <div className="mt-8 text-center text-sm text-gray-500">
            {isLogin ? "Don't have an account? " : "Already have an account? "}
            <button
              onClick={() => { setIsLogin(!isLogin); setError(''); }}
              className="text-cyan-400 hover:text-cyan-300 font-semibold transition-colors relative after:content-[''] after:absolute after:w-full after:h-[1px] after:bg-cyan-400 after:bottom-0 after:left-0 after:scale-x-0 hover:after:scale-x-100 after:transition-transform after:origin-left"
            >
              {isLogin ? 'Sign up' : 'Log in'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
