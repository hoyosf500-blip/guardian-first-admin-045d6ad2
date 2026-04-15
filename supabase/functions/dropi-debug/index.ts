import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, supabaseServiceKey);

    // Get Dropi API key
    const { data: keySetting } = await sb
      .from("app_settings")
      .select("value")
      .eq("key", "dropi_api_key")
      .maybeSingle();
    const apiKey = keySetting?.value || Deno.env.get("DROPI_API_KEY")!;

    // Get store URL
    const { data: urlSetting } = await sb
      .from("app_settings")
      .select("value")
      .eq("key", "dropi_store_url")
      .maybeSingle();
    const origin = urlSetting?.value || "https://rushmira.com/";

    const today = new Date().toISOString().split("T")[0];

    const params = new URLSearchParams({
      result_number: "2",
      start: "0",
      date_from: today,
      date_to: today,
      filter_date_by: "FECHA DE CREADO",
      orderBy: "id",
      orderDirection: "desc",
    });

    const res = await fetch(
      `https://api.dropi.co/integrations/orders/myorders?${params}`,
      {
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "dropi-integration-key": apiKey,
          "Origin": origin,
        },
      },
    );

    const data = await res.json();
    
    // Return raw first 2 orders with all fields
    const orders = data.objects || [];
    const sample = orders.slice(0, 2);
    
    // Get all keys from a sample order
    const allKeys = sample.length > 0 ? Object.keys(sample[0]) : [];
    
    return new Response(
      JSON.stringify({ 
        allKeys,
        sampleOrder: sample[0] || null,
        totalOrders: orders.length,
      }, null, 2),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
