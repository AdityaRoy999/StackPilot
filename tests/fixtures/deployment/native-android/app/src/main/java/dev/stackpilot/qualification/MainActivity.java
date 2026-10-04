package dev.stackpilot.qualification;
public class MainActivity extends android.app.Activity {
  @Override public void onCreate(android.os.Bundle state) {
    super.onCreate(state);
    android.widget.LinearLayout layout=new android.widget.LinearLayout(this);
    layout.setOrientation(android.widget.LinearLayout.VERTICAL);
    layout.setPadding(32,160,32,32);
    layout.setBackgroundColor(android.graphics.Color.WHITE);
    android.widget.TextView title=new android.widget.TextView(this);
    title.setText("StackPilot native APK"); title.setTextSize(24);
    title.setTextColor(android.graphics.Color.BLACK); layout.addView(title);
    android.widget.EditText input=new android.widget.EditText(this);
    input.setContentDescription("Recipient"); input.setHint("Your name");
    input.setTextColor(android.graphics.Color.BLACK); input.setHintTextColor(android.graphics.Color.GRAY);
    layout.addView(input);
    android.widget.Button button=new android.widget.Button(this);
    button.setText("Submit"); button.setContentDescription("Submit"); layout.addView(button);
    android.widget.TextView result=new android.widget.TextView(this);
    result.setContentDescription("Result"); result.setTextColor(android.graphics.Color.BLACK);
    result.setTextSize(24); layout.addView(result);
    button.setOnClickListener(view -> result.setText("Hello "+input.getText().toString()));
    setContentView(layout);
  }
}
