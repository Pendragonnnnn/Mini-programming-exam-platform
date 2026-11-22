import { Component, useEffect, type ErrorInfo, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { refreshAccessToken } from './api/client';
import { Toasts } from './components/ui';
import { Login } from './pages/Login';
import { ResetPassword } from './pages/ResetPassword';
import { Setup } from './pages/Setup';
import { Courses } from './pages/teacher/Courses';
import { StudentDashboard } from './pages/student/Dashboard';
import { Lobby } from './pages/student/Lobby';
import { StudentResults } from './pages/student/Results';
import { Submit } from './pages/student/Submit';
import { Workspace } from './pages/student/Workspace';
import { AuditLog } from './pages/teacher/AuditLog';
import { TeacherDashboard } from './pages/teacher/Dashboard';
import { ExamPicker } from './pages/teacher/ExamPicker';
import { ExamWizard } from './pages/teacher/ExamWizard';
import { Grading } from './pages/teacher/Grading';
import { LiveMonitor } from './pages/teacher/LiveMonitor';
import { QuestionBank } from './pages/teacher/QuestionBank';
import { QuestionEditor } from './pages/teacher/QuestionEditor';
import { TeacherResults } from './pages/teacher/Results';
import { useAuthStore } from './stores/auth';

function Splash() {
  return (
    <div className="app" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <span className="hint">Loading…</span>
    </div>
  );
}

/** Guards a route by role. Teachers may open student exam pages only as a preview. */
function RequireRole({ role, children, allowTeacherPreview }: { role: 'student' | 'teacher'; children: ReactNode; allowTeacherPreview?: boolean }) {
  const { user, bootstrapped } = useAuthStore();
  const loc = useLocation();
  if (!bootstrapped) return <Splash />;
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  if (user.role !== role && !(allowTeacherPreview && user.role === 'teacher')) return <Navigate to={user.role === 'teacher' ? '/teacher' : '/student'} replace />;
  return <>{children}</>;
}

/** Shows a recoverable message instead of a blank page if a screen crashes while rendering. */
class ErrorBoundary extends Component<{ resetKey: string; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Screen crashed', error, info.componentStack);
  }
  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="app" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <div className="card" style={{ maxWidth: 480, padding: 28, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <h1 className="h2">This screen hit a problem</h1>
          <p className="sub">Your saved work is safe. Reload the page to try again.</p>
          <pre className="mono hint" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{this.state.error.message}</pre>
          <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </div>
    );
  }
}

export function App() {
  const loc = useLocation();
  const { bootstrapped, user } = useAuthStore();
  useEffect(() => {
    // Restore the session from the HttpOnly refresh cookie.
    refreshAccessToken().finally(() => useAuthStore.getState().setBootstrapped());
  }, []);
  return (
    <ErrorBoundary resetKey={loc.pathname}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/reset" element={<ResetPassword />} />
        <Route path="/setup" element={<Setup />} />
        <Route path="/" element={!bootstrapped ? <Splash /> : <Navigate to={user ? (user.role === 'teacher' ? '/teacher' : '/student') : '/login'} replace />} />

        <Route path="/student" element={<RequireRole role="student"><StudentDashboard /></RequireRole>} />
        <Route path="/student/results" element={<RequireRole role="student"><StudentResults /></RequireRole>} />
        <Route path="/student/results/:examId" element={<RequireRole role="student"><StudentResults /></RequireRole>} />
        <Route path="/student/exams/:examId/lobby" element={<RequireRole role="student" allowTeacherPreview><Lobby /></RequireRole>} />
        <Route path="/student/exams/:examId/workspace" element={<RequireRole role="student" allowTeacherPreview><Workspace /></RequireRole>} />
        <Route path="/student/exams/:examId/submit" element={<RequireRole role="student" allowTeacherPreview><Submit /></RequireRole>} />

        <Route path="/teacher" element={<RequireRole role="teacher"><TeacherDashboard /></RequireRole>} />
        <Route path="/teacher/exams/new" element={<RequireRole role="teacher"><ExamWizard /></RequireRole>} />
        <Route path="/teacher/exams/:examId/:step" element={<RequireRole role="teacher"><ExamWizardOrTool /></RequireRole>} />
        <Route path="/teacher/courses" element={<RequireRole role="teacher"><Courses /></RequireRole>} />
        <Route path="/teacher/courses/:courseId" element={<RequireRole role="teacher"><Courses /></RequireRole>} />
        <Route path="/teacher/questions" element={<RequireRole role="teacher"><QuestionBank /></RequireRole>} />
        <Route path="/teacher/questions/:questionId" element={<RequireRole role="teacher"><QuestionEditor /></RequireRole>} />
        <Route path="/teacher/monitor" element={<RequireRole role="teacher"><ExamPicker tool="monitor" /></RequireRole>} />
        <Route path="/teacher/grading" element={<RequireRole role="teacher"><ExamPicker tool="grading" /></RequireRole>} />
        <Route path="/teacher/results" element={<RequireRole role="teacher"><ExamPicker tool="results" /></RequireRole>} />
        <Route path="/teacher/audit" element={<RequireRole role="teacher"><AuditLog /></RequireRole>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <Toasts />
    </ErrorBoundary>
  );
}

function ExamWizardOrTool() {
  const step = useLocation().pathname.split('/').pop();
  if (step === 'monitor') return <LiveMonitor />;
  if (step === 'grading') return <Grading />;
  if (step === 'results') return <TeacherResults />;
  return <ExamWizard />;
}
