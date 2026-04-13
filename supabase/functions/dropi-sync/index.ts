import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const DROPI_API_URL = "https://api.dropi.co";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "No autorizado" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseClient = createClient(supabaseUrl, supabaseServiceKey);

    // Verify user
    const anonClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!);
    const { data: { user }, error: authError } = await anonClient.auth.getUser(authHeader.replace("Bearer ", ""));
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Token inválido" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Read Dropi API key from app_settings (DB) first, fallback to env
    let dropiApiKey: string | null = null;
    const { data: setting } = await supabaseClient
      .from("app_settings")
      .select("value")
      .eq("key", "dropi_api_key")
      .maybeSingle();

    if (setting?.value) {
      dropiApiKey = setting.value;
    } else {
      dropiApiKey = Deno.env.get("DROPI_API_KEY") || null;
    }

    if (!dropiApiKey) {
      return new Response(JSON.stringify({ error: "Clave API de Dropi no configurada. Ve a Admin para agregarla." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Parse request body
    let body: Record<string, unknown> = {};
    try {
      body = await req.json();
    } catch {
      // No body is fine
    }

    const from = body.from as string || new Date().toISOString().split("T")[0];
    const untill = body.untill as string || from;
    const status = body.status as string || undefined;

    const queryParams: Record<string, string> = {
      result_number: "200",
      start: "0",
      from,
      untill,
      filter_date_by: "FECHA DE CREADO",
      orderBy: "id",
      orderDirection: "desc",
    };
    if (status) queryParams.status = status;

    const queryString = Object.entries(queryParams)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");

    const dropiResponse = await fetch(
      `${DROPI_API_URL}/integrations/orders/myorders?${queryString}`,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "dropi-integration-key": dropiApiKey,
        },
      }
    );

    if (!dropiResponse.ok) {
      const errText = await dropiResponse.text();
      return new Response(JSON.stringify({ error: `Dropi API error [${dropiResponse.status}]: ${errText}` }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const dropiData = await dropiResponse.json();
    if (!dropiData.isSuccess) {
      return new Response(JSON.stringify({ error: dropiData.message || "Error de Dropi" }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const dropiOrders = dropiData.objects || [];
    if (!Array.isArray(dropiOrders) || dropiOrders.length === 0) {
      return new Response(JSON.stringify({ synced: 0, message: "No hay órdenes nuevas" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Map orders
    const today = new Date().toISOString().split("T")[0];
    const dbOrders = dropiOrders.map((o: Record<string, unknown>) => {
      const products = (o.orderdetails as Array<Record<string, unknown>>) || [];
      const productName = products
        .map((p) => (p.product as Record<string, unknown>)?.name || "")
        .filter(Boolean)
        .join(", ");
      const cantidad = products.reduce(
        (sum, p) => sum + (parseFloat(String(p.quantity || "1")) || 1),
        0
      );
      const createdAt = String(o.created_at || "");
      const fecha = createdAt ? createdAt.split("T")[0] : today;

      return {
        external_id: String(o.id || ""),
        uploaded_by: user.id,
        upload_date: today,
        nombre: `${o.name || ""} ${o.surname || ""}`.trim() || "Sin nombre",
        phone: String(o.phone || "").replace(/[^0-9]/g, ""),
        ciudad: String(o.city || ""),
        departamento: String(o.state || ""),
        producto: productName || "Sin producto",
        estado: String(o.status || "PENDIENTE"),
        fecha,
        fecha_conf: "",
        dias: 0,
        dias_conf: 0,
        valor: parseFloat(String(o.total_order || "0")) || 0,
        flete: parseFloat(String(o.shipping_amount || "0")) || 0,
        costo_prod: 0,
        costo_dev: 0,
        cantidad: Math.round(cantidad),
        direccion: String(o.dir || ""),
        novedad: "",
        guia: String(o.shipping_guide || ""),
        transportadora: String(o.shipping_company || ""),
        tags: "",
        tienda: "",
        novedad_sol: false,
      };
    });

    // Deduplicate
    const externalIds = dbOrders.map((o) => o.external_id).filter(Boolean);
    const { data: existing } = await supabaseClient
      .from("orders")
      .select("external_id")
      .in("external_id", externalIds);

    const existingSet = new Set((existing || []).map((e) => e.external_id));
    const newOrders = dbOrders.filter((o) => !existingSet.has(o.external_id));

    if (newOrders.length === 0) {
      return new Response(
        JSON.stringify({ synced: 0, total: dropiOrders.length, message: "Todos los pedidos ya están sincronizados" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Insert in batches
    let inserted = 0;
    for (let i = 0; i < newOrders.length; i += 50) {
      const batch = newOrders.slice(i, i + 50);
      const { error: insertError, data: insertedData } = await supabaseClient
        .from("orders")
        .insert(batch)
        .select("id");
      if (insertError) {
        console.error("Insert error:", insertError);
      } else {
        inserted += (insertedData?.length || 0);
      }
    }

    return new Response(
      JSON.stringify({
        synced: inserted,
        duplicates: dbOrders.length - newOrders.length,
        total: dropiOrders.length,
        message: `${inserted} pedidos sincronizados desde Dropi`,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("dropi-sync error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Error interno" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
