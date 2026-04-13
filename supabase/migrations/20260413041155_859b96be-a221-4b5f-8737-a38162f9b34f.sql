
-- Create app_role enum
CREATE TYPE public.app_role AS ENUM ('admin', 'operator');

-- Create profiles table
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Create user_roles table
CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role app_role NOT NULL,
  UNIQUE(user_id, role)
);

-- Create orders table
CREATE TABLE public.orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id TEXT,
  uploaded_by UUID NOT NULL REFERENCES auth.users(id),
  upload_date DATE NOT NULL DEFAULT CURRENT_DATE,
  nombre TEXT NOT NULL,
  phone TEXT NOT NULL,
  ciudad TEXT DEFAULT '',
  producto TEXT DEFAULT '',
  estado TEXT DEFAULT '',
  fecha TEXT DEFAULT '',
  fecha_conf TEXT DEFAULT '',
  dias INTEGER DEFAULT 0,
  dias_conf INTEGER DEFAULT 0,
  valor NUMERIC DEFAULT 0,
  flete NUMERIC DEFAULT 0,
  costo_prod NUMERIC DEFAULT 0,
  costo_dev NUMERIC DEFAULT 0,
  cantidad INTEGER DEFAULT 1,
  direccion TEXT DEFAULT '',
  novedad TEXT DEFAULT '',
  guia TEXT DEFAULT '',
  transportadora TEXT DEFAULT '',
  tags TEXT DEFAULT '',
  departamento TEXT DEFAULT '',
  tienda TEXT DEFAULT '',
  novedad_sol BOOLEAN DEFAULT false,
  assigned_to UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Create order_results table
CREATE TABLE public.order_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  phone TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('conf', 'canc', 'noresp')),
  reason TEXT DEFAULT '',
  operator_id UUID NOT NULL REFERENCES auth.users(id),
  result_date DATE NOT NULL DEFAULT CURRENT_DATE,
  result_time TEXT DEFAULT '',
  module TEXT NOT NULL DEFAULT 'confirmar' CHECK (module IN ('confirmar', 'seguimiento', 'rescate')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Create daily_reports table
CREATE TABLE public.daily_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id UUID NOT NULL REFERENCES auth.users(id),
  report_date DATE NOT NULL DEFAULT CURRENT_DATE,
  report_type TEXT NOT NULL CHECK (report_type IN ('apertura', 'cierre')),
  data JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(operator_id, report_date, report_type)
);

-- Create notes table
CREATE TABLE public.notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID REFERENCES public.orders(id) ON DELETE CASCADE,
  phone TEXT NOT NULL,
  note_text TEXT NOT NULL,
  operator_id UUID NOT NULL REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Create touchpoints table
CREATE TABLE public.touchpoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone TEXT NOT NULL,
  action TEXT NOT NULL,
  operator_id UUID NOT NULL REFERENCES auth.users(id),
  action_date DATE NOT NULL DEFAULT CURRENT_DATE,
  action_time TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS on all tables
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.touchpoints ENABLE ROW LEVEL SECURITY;

-- Security definer function to check roles
CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role app_role)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role = _role
  )
$$;

-- Trigger to auto-create profile and assign admin to first user
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _is_first BOOLEAN;
  _name TEXT;
BEGIN
  _is_first := (SELECT COUNT(*) = 0 FROM public.profiles);
  _name := COALESCE(NEW.raw_user_meta_data->>'display_name', NEW.email);
  
  INSERT INTO public.profiles (user_id, display_name)
  VALUES (NEW.id, _name);
  
  IF _is_first THEN
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'admin');
  END IF;
  
  INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'operator')
  ON CONFLICT DO NOTHING;
  
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Update timestamp function
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER update_profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- RLS Policies
CREATE POLICY "Anyone can view profiles" ON public.profiles FOR SELECT TO authenticated USING (true);
CREATE POLICY "Users can update own profile" ON public.profiles FOR UPDATE TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "Users can view own roles" ON public.user_roles FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Users can view orders" ON public.orders FOR SELECT TO authenticated
  USING (uploaded_by = auth.uid() OR assigned_to = auth.uid() OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Users can insert orders" ON public.orders FOR INSERT TO authenticated
  WITH CHECK (uploaded_by = auth.uid());
CREATE POLICY "Users can update orders" ON public.orders FOR UPDATE TO authenticated
  USING (uploaded_by = auth.uid() OR assigned_to = auth.uid() OR public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Users can view results" ON public.order_results FOR SELECT TO authenticated
  USING (operator_id = auth.uid() OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Users can insert results" ON public.order_results FOR INSERT TO authenticated
  WITH CHECK (operator_id = auth.uid());

CREATE POLICY "Users can view own reports" ON public.daily_reports FOR SELECT TO authenticated
  USING (operator_id = auth.uid() OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Users can insert own reports" ON public.daily_reports FOR INSERT TO authenticated
  WITH CHECK (operator_id = auth.uid());

CREATE POLICY "Users can view notes" ON public.notes FOR SELECT TO authenticated USING (true);
CREATE POLICY "Users can insert notes" ON public.notes FOR INSERT TO authenticated
  WITH CHECK (operator_id = auth.uid());

CREATE POLICY "Users can view touchpoints" ON public.touchpoints FOR SELECT TO authenticated USING (true);
CREATE POLICY "Users can insert touchpoints" ON public.touchpoints FOR INSERT TO authenticated
  WITH CHECK (operator_id = auth.uid());

-- Indexes for performance
CREATE INDEX idx_orders_upload_date ON public.orders(upload_date);
CREATE INDEX idx_orders_assigned_to ON public.orders(assigned_to);
CREATE INDEX idx_orders_phone ON public.orders(phone);
CREATE INDEX idx_order_results_date ON public.order_results(result_date);
CREATE INDEX idx_order_results_operator ON public.order_results(operator_id);
CREATE INDEX idx_touchpoints_phone ON public.touchpoints(phone);
CREATE INDEX idx_notes_phone ON public.notes(phone);
