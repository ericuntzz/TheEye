"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Mail, Lock, ArrowRight, AlertCircle, CheckCircle } from "lucide-react";
import { AtriaMark } from "@/components/ui/atria-mark";

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
          "radial-gradient(ellipse at 50% 30%, rgba(77,166,255,0.08) 0%, transparent 50%), #F8F7F4",
      }}
    >
      {/* Floating card container */}
      <div className="relative flex w-full max-w-[1040px] min-h-[640px] overflow-hidden bg-white rounded-3xl shadow-[0px_1px_3px_rgba(0,0,0,0.04),0px_6px_24px_rgba(0,0,0,0.06)] border border-stone/30">
        {/* Mobile ambient glow behind card */}
        <div className="lg:hidden absolute inset-0 overflow-hidden rounded-3xl">
          <div className="absolute inset-0 bg-gradient-to-br from-[#4DA6FF]/5 to-transparent" />
        </div>

        {/* Left panel — image & branding (desktop) */}
        <div className="hidden lg:flex lg:w-[440px] shrink-0 relative overflow-hidden rounded-2xl m-3 bg-[#1B2A4A]">
          <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-80 h-80 bg-[#4DA6FF]/10 rounded-full blur-[100px]" />
          <div className="absolute bottom-1/3 left-1/4 w-48 h-48 bg-[#8B8CFF]/10 rounded-full blur-[80px]" />
          <div className="relative z-10 flex flex-col justify-between p-8 w-full">
            <div className="flex items-center gap-3">
              <AtriaMark size={36} color="white" />
              <span className="text-[15px] font-semibold text-white tracking-[0.18em]">ATRIA</span>
            </div>
            <div>
              <h1 className="text-[28px] font-semibold text-white tracking-tight leading-tight mb-3">
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
            <div className="lg:hidden flex flex-col items-center mb-10">
              <AtriaMark size={52} color="navy" className="block mb-3" />
              <h1 className="text-[20px] font-semibold text-heading tracking-[0.22em]">ATRIA</h1>
            </div>

            {/* Form header */}
            <div className="mb-8">
              <h2 className="text-[26px] font-semibold text-heading tracking-tight">
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
                    className="pl-11 h-12 rounded-xl bg-white border-stone focus-visible:border-primary focus-visible:ring-primary/20 placeholder:text-muted-foreground/40"
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
                    className="pl-11 h-12 rounded-xl bg-white border-stone focus-visible:border-primary focus-visible:ring-primary/20 placeholder:text-muted-foreground/40"
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
                  <CheckCircle className="h-4 w-4 text-green-600 shrink-0 mt-0.5" />
                  <p className="text-sm text-green-600">{message}</p>
                </div>
              )}

              <div className="pt-1">
                <Button
                  type="submit"
                  className="w-full gap-2"
                  size="lg"
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
                className="text-primary font-medium hover:text-primary/80 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary rounded-xl"
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
