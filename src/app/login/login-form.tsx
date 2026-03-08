"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Eye, Loader2, Mail, Lock, ArrowRight, AlertCircle, CheckCircle } from "lucide-react";

export function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSignUp, setIsSignUp] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setMessage(null);

    if (isSignUp) {
      const supabase = createClient();
      const { error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: `${window.location.origin}/api/auth/callback`,
        },
      });
      if (error) {
        setError(error.message);
      } else {
        setMessage("Check your email for a confirmation link.");
      }
    } else {
      const supabase = createClient();
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (error) {
        setError(error.message);
      } else {
        router.push("/dashboard");
      }
    }

    setLoading(false);
  }

  return (
    <div
      className="relative flex min-h-screen items-center justify-center p-4 sm:p-6 lg:p-8 overflow-hidden"
      style={{
        background:
          "radial-gradient(ellipse at 30% 20%, rgba(249,115,22,0.08) 0%, transparent 50%), radial-gradient(ellipse at 70% 80%, rgba(99,102,241,0.06) 0%, transparent 50%), radial-gradient(ellipse at 50% 50%, #0a0e1a 0%, #04060d 100%)",
      }}
    >
      {/* Floating card container */}
      <div className="relative flex w-full max-w-[1040px] min-h-[640px] overflow-hidden rounded-3xl border border-border/40 bg-card/80 shadow-2xl shadow-black/40 backdrop-blur-sm">
        {/* Mobile ambient glow behind card */}
        <div className="lg:hidden absolute inset-0 overflow-hidden rounded-3xl">
          <div className="absolute inset-0 bg-gradient-to-br from-primary/20 via-primary/5 to-transparent" />
          <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent" />
          <div className="absolute inset-0 bg-gradient-to-br from-orange-900/30 via-slate-900/50 to-slate-950/80" />
          <div className="absolute top-[16%] left-1/2 -translate-x-1/2 w-64 h-64 bg-primary/15 rounded-full blur-[80px]" />
          <div className="absolute bottom-1/4 left-1/3 w-40 h-40 bg-amber-500/10 rounded-full blur-[60px]" />
        </div>

        {/* Left panel — image & branding (desktop) */}
        <div className="hidden lg:flex lg:w-[440px] shrink-0 relative overflow-hidden rounded-2xl m-3">
          <div className="absolute inset-0 bg-gradient-to-br from-primary/30 via-primary/5 to-transparent" />
          <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />
          <div className="absolute inset-0 bg-gradient-to-br from-orange-900/40 via-slate-900/60 to-slate-950/90" />
          <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-80 h-80 bg-primary/15 rounded-full blur-[100px]" />
          <div className="absolute bottom-1/3 left-1/4 w-48 h-48 bg-amber-500/10 rounded-full blur-[80px]" />
          <div
            className="absolute inset-0 opacity-[0.15]"
            style={{
              backgroundImage:
                "radial-gradient(circle at 20% 50%, rgba(249,115,22,0.08) 0%, transparent 50%), radial-gradient(circle at 80% 20%, rgba(249,115,22,0.05) 0%, transparent 40%), radial-gradient(circle at 50% 80%, rgba(251,191,36,0.04) 0%, transparent 40%)",
            }}
          />
          <div className="relative z-10 flex flex-col justify-between p-8 w-full">
            <div className="flex items-center gap-2.5">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-white/10 backdrop-blur-sm border border-white/10">
                <Eye className="h-[18px] w-[18px] text-white" />
              </div>
              <span className="text-[15px] font-semibold text-white tracking-tight">Atria</span>
            </div>
            <div>
              <h1 className="text-[28px] font-bold text-white tracking-tight leading-tight mb-3">
                See What Others Miss
              </h1>
              <p className="text-white/60 text-[15px] leading-relaxed max-w-[320px]">
                AI-powered visual intelligence for property inspections. Detect, compare, and report — automatically.
              </p>
              <div className="flex items-center gap-2 mt-6">
                <div className="w-6 h-1.5 rounded-full bg-white/70" />
                <div className="w-1.5 h-1.5 rounded-full bg-white/30" />
                <div className="w-1.5 h-1.5 rounded-full bg-white/30" />
              </div>
            </div>
          </div>
        </div>

        {/* Right panel — form */}
        <div className="relative z-10 flex flex-1 items-center justify-center px-6 py-10 sm:px-10 lg:px-14">
          <div className="w-full max-w-[360px]">
            {/* Mobile logo */}
            <div className="lg:hidden text-center mb-10">
              <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-white/10 backdrop-blur-sm border border-white/10">
                <Eye className="h-6 w-6 text-primary" />
              </div>
              <h1 className="text-xl font-bold text-white tracking-tight">Atria</h1>
            </div>

            {/* Form header */}
            <div className="mb-8">
              <h2 className="text-[26px] font-bold text-foreground tracking-tight">
                {isSignUp ? "Create an account" : "Welcome back"}
              </h2>
              <p className="text-sm text-muted-foreground mt-2">
                {isSignUp
                  ? "Get started with AI-powered inspections"
                  : "Sign in to continue to your dashboard"}
              </p>
            </div>

            {/* Form */}
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="email" className="text-[13px] font-medium text-muted-foreground">
                  Email
                </Label>
                <div className="relative">
                  <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/50 pointer-events-none" />
                  <Input
                    id="email"
                    name="email"
                    type="email"
                    autoComplete="email"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    className="pl-11 h-12 rounded-xl bg-background/60 border-border/50 text-foreground placeholder:text-muted-foreground/40 focus-visible:border-primary focus-visible:ring-primary/20"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="password" className="text-[13px] font-medium text-muted-foreground">
                  Password
                </Label>
                <div className="relative">
                  <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/50 pointer-events-none" />
                  <Input
                    id="password"
                    name="password"
                    type="password"
                    autoComplete={isSignUp ? "new-password" : "current-password"}
                    placeholder="Enter your password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    minLength={6}
                    className="pl-11 h-12 rounded-xl bg-background/60 border-border/50 text-foreground placeholder:text-muted-foreground/40 focus-visible:border-primary focus-visible:ring-primary/20"
                  />
                </div>
              </div>

              {error && (
                <div className="flex items-start gap-2.5 rounded-xl bg-destructive/10 border border-destructive/20 px-3.5 py-3">
                  <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
                  <p className="text-sm text-destructive">{error}</p>
                </div>
              )}

              {message && (
                <div className="flex items-start gap-2.5 rounded-xl bg-green-500/10 border border-green-500/20 px-3.5 py-3">
                  <CheckCircle className="h-4 w-4 text-green-400 shrink-0 mt-0.5" />
                  <p className="text-sm text-green-400">{message}</p>
                </div>
              )}

              <div className="pt-1">
                <Button
                  type="submit"
                  className="w-full h-12 rounded-xl text-sm font-semibold gap-2"
                  disabled={loading}
                >
                  {loading ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      {isSignUp ? "Creating account..." : "Signing in..."}
                    </>
                  ) : (
                    <>
                      {isSignUp ? "Create account" : "Sign In"}
                      <ArrowRight className="h-4 w-4" />
                    </>
                  )}
                </Button>
              </div>
            </form>

            {/* Toggle sign in / sign up */}
            <p className="text-center text-sm text-muted-foreground mt-8">
              {isSignUp ? "Already have an account?" : "Don't have an account?"}{" "}
              <button
                type="button"
                className="text-primary font-medium hover:text-primary/80 transition-colors"
                onClick={() => {
                  setIsSignUp(!isSignUp);
                  setError(null);
                  setMessage(null);
                }}
              >
                {isSignUp ? "Sign in" : "Sign up"}
              </button>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
