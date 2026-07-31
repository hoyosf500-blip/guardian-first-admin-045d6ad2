import { Link, useLocation } from "react-router-dom";
import { useEffect } from "react";

// Ruta catch-all `*` (App.tsx), FUERA de ProtectedLayout: la puede ver una
// operadora logueada que siguió un link roto o un bookmark viejo, así que
// habla en español (como toda la app) y vuelve con <Link> (navegación SPA —
// el <a href> viejo recargaba la app completa). El `/` pasa por IndexRedirect,
// que manda a cada rol a su pantalla de trabajo.
const NotFound = () => {
  const location = useLocation();

  useEffect(() => {
    console.error("404: intento de acceso a ruta inexistente:", location.pathname);
  }, [location.pathname]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted">
      <div className="text-center px-6">
        <h1 className="mb-4 text-4xl font-bold text-foreground">404</h1>
        <p className="mb-2 text-xl text-muted-foreground">Esta página no existe</p>
        <p className="mb-6 text-sm text-muted-foreground font-mono break-all">{location.pathname}</p>
        <Link to="/" className="text-accent underline hover:text-accent/80">
          Volver al inicio
        </Link>
      </div>
    </div>
  );
};

export default NotFound;
